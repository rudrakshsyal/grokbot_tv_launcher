'use strict';
// Samsung TV local remote control (the "SmartView" WebSocket API that Samsung TVs expose to remote apps).
// Zero npm deps: a tiny RFC 6455 WebSocket client over tls.connect (the TV uses a self-signed cert on :8002), plus
// app launch via the TV's REST API (:8001) with a WebSocket ed.apps.launch fallback, and Wake-on-LAN (UDP magic packet).
// Protocol as used by the samsungtvws library (github.com/xchwarze/samsung-tv-ws-api):
//   wss://<tv>:8002/api/v2/channels/samsung.remote.control?name=<base64 name>[&token=<token>]
//   first connect: the TV shows an "Allow" prompt; on Allow it sends {event:'ms.channel.connect', data:{token}} -> saved.
//   denied: {event:'ms.channel.unauthorized'}.   key: {method:'ms.remote.control', params:{Cmd:'Click', DataOfCmd:'KEY_UP',
//   Option:'false', TypeOfRemote:'SendRemoteKey'}}.   launch: {method:'ms.channel.emit', params:{event:'ed.apps.launch',
//   to:'host', data:{appId, action_type:'DEEP_LINK'|'NATIVE_LAUNCH', metaTag:''}}}.
const tls = require('tls'), net = require('net'), http = require('http'), crypto = require('crypto'), fs = require('fs'),
  path = require('path'), dgram = require('dgram'), EventEmitter = require('events');

// Keys documented for Tizen TVs (samsungtvws / Samsung remote key list). Play/Pause has no single key on most
// firmware, so the phone sends KEY_PLAY / KEY_PAUSE (and the relay alternates them for a toggle button).
const KEYS = new Set(['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_RETURN', 'KEY_HOME', 'KEY_EXIT',
  'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_FF', 'KEY_REWIND', 'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE', 'KEY_POWER',
  'KEY_INFO', 'KEY_MENU', 'KEY_TOOLS', 'KEY_SOURCE', 'KEY_YELLOW']);
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode) {
  const payload = Buffer.from(text || ''), len = payload.length, mask = crypto.randomBytes(4);
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | (opcode == null ? 0x1 : opcode);   // FIN + opcode (client frames are always masked)
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, out]);
}
// Parses as many complete frames as `buf` holds. Returns { frames:[{fin,opcode,payload}], rest }.
function decodeFrames(buf) {
  const frames = [];
  for (;;) {
    if (buf.length < 2) break;
    const b0 = buf[0], b1 = buf[1], masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); off = 10; }
    const mlen = masked ? 4 : 0;
    if (buf.length < off + mlen + len) break;
    let payload = buf.slice(off + mlen, off + mlen + len);
    if (masked) { const m = buf.slice(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    frames.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload });
    buf = buf.slice(off + mlen + len);
  }
  return { frames, rest: buf };
}

class TvRemote extends EventEmitter {
  constructor(o) {
    super(); o = o || {};
    this.host = o.host || '';                // TV_IP; empty = remote/power features stay off (no LAN traffic)
    this.wsPort = o.wsPort || 8002;          // wss (TokenAuthSupport TVs, 2018+)
    this.plainPort = o.plainPort || 8001;    // ws, only for TVs whose /api/v2/ says TokenAuthSupport "false"
    this.restPort = o.restPort || 8001;
    this.wsMode = o.wsMode || 'auto';        // auto | wss | ws
    this.tokenAuth = null;                   // from GET /api/v2/ (TvPower feeds it); null = unknown -> wss
    this.name = o.name || 'Glass Home Remote';
    this.tokenFile = o.tokenFile || path.join(__dirname, '.secrets', 'tv-token.json');
    this.mac = (o.mac || '').trim();
    this.connectTimeout = o.connectTimeout || 4000;
    this.allowTimeout = o.allowTimeout || 45000;    // how long we keep the Allow prompt open
    this.keepAliveMs = o.keepAliveMs || 10 * 60000; // reconnect after drops only while used recently
    this.pingMs = o.pingMs || 20000;
    this.restTimeout = o.restTimeout || 8000;
    this.backoff = o.backoff || [1000, 2000, 4000, 8000, 15000, 30000];
    this.autoPair = o.autoPair !== false;   // the first key press may start pairing once; after that only pair()
    // states: idle | connecting | connected | offline | unpaired | pairing | pair-timeout | denied
    this.lastError = null; this.sock = null; this.buf = Buffer.alloc(0); this.frag = null; this.tries = 0;
    this.lastUse = 0; this.waiters = []; this.retryT = null; this.pingT = null; this.closed = false; this.playing = false;
    this.offlineUntil = 0; this.offFails = 0; this.pairAttempted = false; this.powerOff = false; this.pairingStarted = 0;
    this.token = this.readToken();
    this.state = this.token ? 'idle' : 'unpaired';
  }
  readToken() { try { return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).token || null; } catch (e) { return null; } }
  saveToken(t) {
    this.token = String(t);
    try {
      fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.tokenFile, JSON.stringify({ token: this.token, host: this.host, name: this.name, savedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      fs.chmodSync(this.tokenFile, 0o600);
    } catch (e) { this.lastError = 'could not save token: ' + e.message; }
  }
  secure() { return this.wsMode === 'wss' || (this.wsMode !== 'ws' && this.tokenAuth !== false); }
  // Same URL samsungtvws builds: name = base64(utf8 name) (not URL-encoded there either; '=' is legal in a query).
  url() {
    const name = Buffer.from(this.name).toString('base64');
    return '/api/v2/channels/samsung.remote.control?name=' + name + (this.token ? '&token=' + encodeURIComponent(this.token) : '');
  }
  status() {
    return { state: this.state, connected: this.state === 'connected', paired: !!this.token, pairing: this.state === 'pairing',
      needsAllow: this.state === 'pairing', host: this.host, wol: !!this.mac, transport: this.secure() ? 'wss:' + this.wsPort : 'ws:' + this.plainPort,
      lastError: this.lastError, pairingSince: this.state === 'pairing' ? this.pairingStarted : null };
  }
  setState(s, err) { if (err !== undefined) this.lastError = err; if (this.state !== s) { this.state = s; this.emit('state', this.status()); } }
  err(code, msg) { return Object.assign(new Error(msg || code), { code }); }

  // Resolves when connected. Never pops the Allow prompt except the very first time (autoPair); while the TV is known to be
  // off/unreachable it fails fast (no reconnect per key press) until the backoff passes or TvPower sees the TV come on.
  ready(wait) {
    this.lastUse = Date.now();
    if (this.state === 'connected') return Promise.resolve();
    if (!this.token) {
      if (this.state === 'pairing') return Promise.reject(this.err('pairing', 'choose Allow on the TV'));
      if (this.autoPair && !this.pairAttempted && !this.gated()) { this.pair(); return Promise.reject(this.err('pairing', 'choose Allow on the TV')); }
      return Promise.reject(this.err(this.state === 'offline' ? 'offline' : this.state === 'denied' || this.state === 'pair-timeout' ? this.state : 'unpaired', this.lastError || 'not paired'));
    }
    if (this.gated()) return Promise.reject(this.err('offline', this.lastError || 'TV off or unreachable'));
    if (!this.sock) this.connect();
    return new Promise((res, rej) => {
      const w = { res, rej };
      w.t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(this.err(this.state === 'connecting' || this.state === 'idle' ? 'offline' : this.state)); }, wait == null ? 4000 : wait);
      this.waiters.push(w);
    });
  }
  gated() { return (this.powerOff || Date.now() < this.offlineUntil) && this.state !== 'connected' && !this.sock; }
  // Explicit pairing (Retry pair button / first key press): one connect without a token; the TV shows Allow/Deny.
  pair() {
    this.lastUse = Date.now();
    if (this.token) { if (!this.sock && this.state !== 'connected') { this.offlineUntil = 0; this.connect(); } return this.status(); }
    if (this.state === 'pairing' && this.sock) return this.status();
    this.pairAttempted = true; this.offlineUntil = 0; this.teardown();
    this.connect();
    return this.status();
  }
  // TvPower hooks: the REST poll knows whether the TV is on, so key presses don't hammer an off TV.
  setPower(on) {
    this.powerOff = !on;
    if (!on) { clearTimeout(this.retryT); this.retryT = null; }
    if (on) { this.offlineUntil = 0; this.offFails = 0; if (this.state === 'offline') this.setState(this.token ? 'idle' : 'unpaired', null); }
  }
  flush(err) { const ws = this.waiters; this.waiters = []; ws.forEach(w => { clearTimeout(w.t); err ? w.rej(err) : w.res(); }); }

  connect() {
    if (this.sock || this.closed) return;
    if (!this.host) { this.setState('offline', 'TV_IP not set'); this.flush(this.err('offline', 'TV_IP not set')); return; }
    clearTimeout(this.retryT); this.retryT = null;
    const pairing = !this.token;
    if (pairing) { this.pairingStarted = Date.now(); this.setState('pairing', null); }
    else if (this.state !== 'offline') this.setState('connecting', null);   // reconnects while offline stay quiet
    const key = crypto.randomBytes(16).toString('base64'), secure = this.secure(), port = secure ? this.wsPort : this.plainPort;
    let s;
    if (secure) { const opts = { host: this.host, port, rejectUnauthorized: false }; if (!net.isIP(this.host)) opts.servername = this.host; s = tls.connect(opts); }   // TV cert is self-signed
    else s = net.connect({ host: this.host, port });
    this.sock = s;
    let upgraded = false, head = Buffer.alloc(0), gotConnect = false, allowT = null;
    const fail = (state, msg) => {
      if (this.sock !== s) return;
      clearTimeout(openT); clearTimeout(allowT); this.teardown();
      if (state === 'offline') { this.offFails++; this.offlineUntil = Date.now() + this.backoff[Math.min(this.offFails - 1, this.backoff.length - 1)]; if (pairing && !upgraded) this.pairAttempted = false; }
      this.setState(state === 'offline' && pairing && !upgraded ? 'offline' : state, msg);
      this.flush(this.err(state, msg)); this.scheduleRetry();
    };
    const openT = setTimeout(() => fail('offline', 'TV not reachable'), this.connectTimeout);
    s.setNoDelay(true);
    s.on(secure ? 'secureConnect' : 'connect', () => {
      s.write('GET ' + this.url() + ' HTTP/1.1\r\nHost: ' + this.host + ':' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('data', d => {
      if (!upgraded) {
        head = Buffer.concat([head, d]);
        const i = head.indexOf('\r\n\r\n'); if (i < 0) return;
        const lines = head.slice(0, i).toString().split('\r\n'), hdr = {};
        lines.slice(1).forEach(l => { const c = l.indexOf(':'); if (c > 0) hdr[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim(); });
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (!/^HTTP\/1\.1 101/.test(lines[0]) || hdr['sec-websocket-accept'] !== accept) return fail('offline', 'handshake refused (' + lines[0] + ')');
        upgraded = true; clearTimeout(openT);
        // First time the TV now shows Allow/Deny; 'ms.channel.connect' (with the token) follows when the user allows.
        allowT = setTimeout(() => fail(pairing ? 'pair-timeout' : 'offline', pairing ? 'No answer to the Allow prompt' : 'no reply from TV'), pairing ? this.allowTimeout : this.connectTimeout);
        d = head.slice(i + 4);
        if (!d.length) return;
      }
      this.buf = Buffer.concat([this.buf, d]);
      const r = decodeFrames(this.buf); this.buf = r.rest;
      r.frames.forEach(f => {
        if (f.opcode === 0x9) return s.write(encodeFrame(f.payload, 0xA));          // ping -> pong
        if (f.opcode === 0xA) { this.pongAt = Date.now(); return; }
        if (f.opcode === 0x8) { try { s.write(encodeFrame('', 0x8)); } catch (e) {} return s.end(); }
        let text;
        if (f.opcode === 0x1 || f.opcode === 0x2) { if (!f.fin) { this.frag = [f.payload]; return; } text = f.payload.toString(); }
        else if (f.opcode === 0x0 && this.frag) { this.frag.push(f.payload); if (!f.fin) return; text = Buffer.concat(this.frag).toString(); this.frag = null; }
        else return;
        let msg; try { msg = JSON.parse(text); } catch (e) { return; }
        this.emit('message', msg);
        if (/^ms\.remote\.ime/.test(msg.event || '')) this.emit('ime', msg.event, msg.data);   // system keyboard up/down (v6.1)
        if (msg.event === 'ms.channel.connect') {
          gotConnect = true; clearTimeout(allowT);
          if (msg.data && msg.data.token && msg.data.token !== this.token) this.saveToken(msg.data.token);
          this.tries = 0; this.offFails = 0; this.offlineUntil = 0; this.setState('connected', null); this.flush(); this.startPing();
        } else if (msg.event === 'ms.channel.unauthorized') {
          fail('denied', 'The TV blocked "' + this.name + '"');
        } else if (msg.event === 'ms.channel.timeOut') {
          fail(pairing ? 'pair-timeout' : 'offline', pairing ? 'The TV timed out the Allow prompt' : 'TV timed out the connection');
        } else if (msg.event === 'ms.error') { this.lastError = String((msg.data && msg.data.message) || 'ms.error').slice(0, 120); }
      });
    });
    s.on('error', e => fail(this.state === 'denied' ? 'denied' : 'offline', /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|EHOSTDOWN/.test(e.code || '') ? 'TV not reachable (' + e.code + ')' : e.message));
    s.on('close', () => {
      if (this.sock !== s) return;
      if (gotConnect) { clearTimeout(allowT); this.teardown(); this.setState('offline', 'connection closed'); this.offlineUntil = 0; this.flush(this.err('offline')); return this.scheduleRetry(); }
      fail(pairing ? (upgraded ? 'pair-timeout' : 'offline') : 'offline', pairing && upgraded ? 'The TV closed the pairing request' : 'TV not reachable');
    });
  }
  teardown() { clearInterval(this.pingT); this.pingT = null; const s = this.sock; this.sock = null; this.buf = Buffer.alloc(0); this.frag = null; if (s) { s.removeAllListeners('data'); s.removeAllListeners('close'); s.on('error', () => {}); try { s.destroy(); } catch (e) {} } }
  startPing() { clearInterval(this.pingT); this.pingT = setInterval(() => { if (this.sock && this.state === 'connected') try { this.sock.write(encodeFrame('rh', 0x9)); } catch (e) {} }, this.pingMs); if (this.pingT.unref) this.pingT.unref(); }
  scheduleRetry() {
    if (this.closed || this.retryT || this.state === 'denied') return;
    if (!this.token) return;                                  // never re-pop the Allow prompt by itself
    if (this.powerOff) return;                                // TvPower will reconnect when the TV comes on
    if (Date.now() - this.lastUse > this.keepAliveMs) { if (this.state !== 'offline') this.setState('idle'); return; }
    const d = this.backoff[Math.min(this.tries++, this.backoff.length - 1)];
    this.retryT = setTimeout(() => { this.retryT = null; this.connect(); }, d);
    if (this.retryT.unref) this.retryT.unref();
  }
  sendJSON(o) { if (!this.sock || this.state !== 'connected') throw Object.assign(new Error('not connected'), { code: this.state }); this.sock.write(encodeFrame(JSON.stringify(o))); }
  async key(k, cmd) {
    if (k === 'PLAYPAUSE') { k = this.playing ? 'KEY_PAUSE' : 'KEY_PLAY'; }
    if (!KEYS.has(k)) throw Object.assign(new Error('unknown key'), { code: 'bad-key' });
    await this.ready();
    this.sendJSON({ method: 'ms.remote.control', params: { Cmd: cmd || 'Click', DataOfCmd: k, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
    if (k === 'KEY_PLAY') this.playing = true; else if (k === 'KEY_PAUSE' || k === 'KEY_STOP') this.playing = false;
    return k;
  }
  // App launch: REST first (POST :8001/api/v2/applications/<id>), then ed.apps.launch over the WebSocket.
  async launch(appId, opts) {
    if (!APP_ID.test(appId || '')) throw Object.assign(new Error('bad app id'), { code: 'bad-app' });
    this.lastUse = Date.now();
    const rest = await this.restLaunch(appId).catch(e => ({ ok: false, error: e.message }));
    if (rest.ok) return { via: 'rest', appId };
    if (!this.token && opts && opts.noPair) throw this.err('rest-failed', 'REST launch failed: ' + (rest.error || rest.status));
    await this.ready();
    this.sendJSON({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId, action_type: 'DEEP_LINK', metaTag: '' } } });
    return { via: 'websocket', appId, rest: rest.error || rest.status };
  }
  // ed.apps.launch with a deep link (SmartView API). Honored by some apps/firmware, ignored by others (then it is a plain
  // launch), so callers verify with appStatus and say what really happened.
  async deepLink(appId, metaTag) {
    if (!APP_ID.test(appId || '')) throw Object.assign(new Error('bad app id'), { code: 'bad-app' });
    this.lastUse = Date.now();
    await this.ready();
    this.sendJSON({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId, action_type: 'DEEP_LINK', metaTag: String(metaTag || '') } } });
    return { via: 'websocket-deeplink', appId };
  }
  // Text into the TV's system keyboard (samsungtvws format): only works while the TV reports ms.remote.imeStart.
  // Apps with their own keyboard (YouTube, Netflix) ignore it.
  async inputString(text) {
    await this.ready(); this.lastUse = Date.now();
    if (!this.textNoted) { this.textNoted = true; try { this.sendJSON({ method: 'ms.channel.emit', params: { event: 'custom.remote.textReceived', to: 'broadcast', data: '' } }); } catch (e) {} }
    this.sendJSON({ method: 'ms.remote.control', params: { Cmd: Buffer.from(String(text), 'utf8').toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' } });
  }
  async inputEnd() { await this.ready(); this.sendJSON({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } }); }
  restGet(p, timeout) {
    if (!this.host) return Promise.reject(this.err('no-host', 'TV_IP not set'));
    return new Promise((res, rej) => {
      const r = http.get({ host: this.host, port: this.restPort, path: p, timeout: timeout || this.restTimeout }, rs => {
        let b = ''; rs.on('data', c => { b += c; if (b.length > 1e5) rs.destroy(); });
        rs.on('end', () => { if (rs.statusCode !== 200) return rej(this.err('http', 'HTTP ' + rs.statusCode)); try { res(JSON.parse(b)); } catch (e) { rej(this.err('bad-json', 'bad JSON')); } });
      });
      r.on('timeout', () => r.destroy(this.err('timeout', 'REST timeout'))); r.on('error', rej);
    });
  }
  appStatus(appId) { return this.restGet('/api/v2/applications/' + encodeURIComponent(appId)); }
  restLaunch(appId) {
    if (!this.host) return Promise.reject(this.err('no-host', 'TV_IP not set'));
    return new Promise((res, rej) => {
      const r = http.request({ host: this.host, port: this.restPort, method: 'POST', path: '/api/v2/applications/' + encodeURIComponent(appId), timeout: this.restTimeout, headers: { 'Content-Length': 0 } }, rs => {
        let b = ''; rs.on('data', c => { b += c; if (b.length > 1e4) rs.destroy(); });
        rs.on('end', () => res({ ok: rs.statusCode === 200 && !/^\s*false\s*$/.test(b), status: rs.statusCode, body: b.slice(0, 200) }));
      });
      r.on('timeout', () => r.destroy(new Error('REST timeout'))); r.on('error', rej); r.end();
    });
  }
  // Wake-on-LAN magic packet: 6x 0xFF + 16x MAC over UDP to ports 9 and 7. v6: sent to every target (limited broadcast,
  // the TV subnet's directed broadcast, the TV's own IP) `repeats` times `gapMs` apart, because one UDP packet over
  // Wi-Fi is easily lost. The TV must have Settings › General › Network › Expert Settings › Power On with Mobile on.
  wakeTargets(extra) {
    const out = [];
    [].concat(extra || [], '255.255.255.255', subnetBroadcast(this.host), this.host).forEach(a => { if (a && net.isIPv4(a) && out.indexOf(a) < 0) out.push(a); });
    return out;
  }
  wake(opts) {
    opts = opts || {};
    const mac = normMac(this.mac);
    if (!mac) return Promise.reject(Object.assign(new Error('TV_MAC not set'), { code: 'no-mac' }));
    const pkt = magicPacket(mac), ports = opts.ports || [9, 7];
    const addrs = opts.addresses || (opts.address ? [opts.address] : this.wakeTargets());
    const repeats = Math.max(1, opts.repeats || 1), gap = opts.gapMs == null ? 300 : opts.gapMs;
    return new Promise((res, rej) => {
      const s = dgram.createSocket('udp4');
      let sent = 0, failed = 0, lastErr = null, done = false;
      const total = addrs.length * ports.length * repeats;
      const fin = () => { if (done) return; done = true; try { s.close(); } catch (x) {} if (!sent) rej(lastErr || new Error('WoL send failed')); else res({ sent, failed, mac, addresses: addrs, repeats }); };
      s.on('error', e => { lastErr = e; fin(); });
      s.bind(() => {
        try { s.setBroadcast(true); } catch (e) {}
        const round = i => {
          addrs.forEach(addr => ports.forEach(p => s.send(pkt, p, addr, err => {
            if (err) { failed++; lastErr = err; } else sent++;
            if (sent + failed === total) fin();
          })));
          if (i + 1 < repeats) setTimeout(() => round(i + 1), gap);
        };
        round(0);
      });
    });
  }
  close() { this.closed = true; clearTimeout(this.retryT); this.teardown(); this.flush(Object.assign(new Error('closed'), { code: 'closed' })); }
}
// directed broadcast of the local interface on the same subnet as `host` (e.g. 192.168.1.255 for a /24); null if none
function subnetBroadcast(host) {
  if (!net.isIPv4(host || '')) return null;
  const toN = a => a.split('.').reduce((n, x) => (n * 256) + (+x), 0) >>> 0, toA = n => [24, 16, 8, 0].map(b => (n >>> b) & 255).join('.');
  const h = toN(host), ifs = require('os').networkInterfaces();
  for (const k of Object.keys(ifs)) for (const i of ifs[k] || []) {
    if (i.internal || (i.family !== 'IPv4' && i.family !== 4) || !i.netmask) continue;
    const m = toN(i.netmask), ip = toN(i.address);
    if (m && ((ip & m) >>> 0) === ((h & m) >>> 0)) return toA(((ip & m) | (~m >>> 0)) >>> 0);
  }
  return null;
}
function normMac(m) { const h = String(m || '').replace(/[^0-9a-f]/gi, ''); return h.length === 12 ? h.toLowerCase().match(/../g).join(':') : null; }
function magicPacket(mac) { const b = Buffer.from(mac.replace(/:/g, ''), 'hex'), out = Buffer.alloc(102, 0xff); for (let i = 0; i < 16; i++) b.copy(out, 6 + i * 6); return out; }

module.exports = { TvRemote, KEYS, APP_ID, encodeFrame, decodeFrames, magicPacket, normMac, subnetBroadcast };
