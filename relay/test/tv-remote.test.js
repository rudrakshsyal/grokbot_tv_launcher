'use strict';
// TV remote tests against a fake Samsung TV: a local TLS WebSocket server (self-signed cert made with openssl in a temp
// dir) + a fake REST API. Checks handshake, Allow/token capture + reuse, key frame format, ping/pong, fragmented
// messages, reconnect, denial, REST + WebSocket app launch, Wake-on-LAN packet, and the relay's /remote/* routes.
const fs = require('fs'), os = require('os'), path = require('path'),
  dgram = require('dgram'), assert = require('assert');
const R = require('../tv-remote');

const FAKE = require('./fake-tv'), srvFrame = FAKE.srvFrame;
let TV, rest;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t = Date.now(); while (!fn()) { if (Date.now() - t > (ms || 3000)) throw new Error('timeout waiting'); await wait(10); } }
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok  ' + m); };

(async () => {
  TV = await FAKE.start(); rest = TV.rest;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvremote-'));
  const wsPort = TV.wsPort, restPort = TV.restPort, tokenFile = path.join(tmp, '.secrets', 'tv-token.json');
  const tv = new R.TvRemote({ host: '127.0.0.1', wsPort, restPort, tokenFile, backoff: [50], pingMs: 60000 });

  // frame codec
  const f = R.encodeFrame('hello'); ok((f[0] === 0x81) && (f[1] & 0x80) && (f[1] & 0x7f) === 5, 'client text frame is FIN+text and masked');
  ok(R.decodeFrames(f).frames[0].payload.toString() === 'hello', 'masked frame round-trips');
  const big = 'x'.repeat(70000); ok(R.decodeFrames(R.encodeFrame(big)).frames[0].payload.length === 70000, '64-bit length frames');

  // pairing: no token -> Allow prompt -> token saved (mode 600) from a fragmented ms.channel.connect
  ok(!tv.status().paired, 'starts unpaired');
  await tv.key('KEY_UP').then(() => ok(false, 'pairing key'), e => ok(e.code === 'pairing' && tv.state === 'pairing', 'first key press starts pairing (state pairing, key not sent)'));
  let perr = null; await tv.key('KEY_UP').catch(e => { perr = e; }); await tv.key('KEY_DOWN').catch(() => {}); await wait(30);
  ok(perr && perr.code === 'pairing' && TV.urls.length === 1, 'more presses while the Allow prompt is up do not reconnect');
  await until(() => tv.state === 'connected');
  await tv.key('KEY_UP');
  const u0 = new URL('http://x' + TV.urls[0]);
  ok(u0.pathname === '/api/v2/channels/samsung.remote.control', 'handshake path');
  ok(Buffer.from(u0.searchParams.get('name'), 'base64').toString() === 'Glass Home Remote', 'name is base64 "Glass Home Remote"');
  ok(!u0.searchParams.get('token'), 'first connect has no token');
  ok(TV.headers[0].upgrade === 'websocket' && TV.headers[0]['sec-websocket-version'] === '13', 'upgrade headers');
  ok(tv.state === 'connected' && tv.token === 'T-12345', 'token captured from ms.channel.connect');
  const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  ok(saved.token === 'T-12345' && (fs.statSync(tokenFile).mode & 0o777) === 0o600, 'token file saved with mode 600');
  await until(() => TV.frames.length >= 1);
  ok(JSON.stringify(TV.frames[0]) === JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_UP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } }), 'key frame format');
  ok(TV.unmasked === 0, 'all client frames masked');

  // ping/pong
  TV.conns[TV.conns.length - 1].write(srvFrame('png1', 0x9));
  await until(() => TV.pongs.length); ok(TV.pongs[0] === 'png1', 'pong echoes ping payload');

  // validation
  await tv.key('KEY_BOGUS').then(() => ok(false, 'bad key'), e => ok(e.code === 'bad-key', 'unknown keys rejected'));
  await tv.key('PLAYPAUSE'); await tv.key('PLAYPAUSE');
  await until(() => TV.frames.length >= 3);
  ok(TV.frames[1].params.DataOfCmd === 'KEY_PLAY' && TV.frames[2].params.DataOfCmd === 'KEY_PAUSE', 'play/pause toggle alternates KEY_PLAY / KEY_PAUSE');

  // reconnect after the TV drops the socket, reusing the saved token
  const before = TV.urls.length;
  TV.conns[TV.conns.length - 1].destroy();
  await until(() => tv.state !== 'connected');
  await until(() => tv.state === 'connected' && TV.urls.length > before, 3000);
  ok(new URL('http://x' + TV.urls[TV.urls.length - 1]).searchParams.get('token') === 'T-12345', 'reconnects with &token=');
  await tv.key('KEY_VOLUP'); await until(() => TV.frames.some(x => x.params && x.params.DataOfCmd === 'KEY_VOLUP')); ok(true, 'keys work after reconnect');

  // a fresh instance loads the token from disk
  const tv2 = new R.TvRemote({ host: '127.0.0.1', wsPort, restPort, tokenFile });
  ok(tv2.status().paired && tv2.url().indexOf('&token=T-12345') > 0, 'token reused from file on restart');

  // app launch: REST first, WebSocket ed.apps.launch fallback
  let r = await tv.launch('9Ur5IzDKqV.TizenYouTube');
  ok(r.via === 'rest' && rest.calls[0] === 'POST /api/v2/applications/9Ur5IzDKqV.TizenYouTube', 'REST app launch');
  rest.status = 404; r = await tv.launch('GlassHome1.launcher');
  await until(() => TV.frames.some(x => x.method === 'ms.channel.emit'));
  const em = TV.frames.filter(x => x.method === 'ms.channel.emit')[0];
  ok(r.via === 'websocket' && em.params.event === 'ed.apps.launch' && em.params.to === 'host' && em.params.data.appId === 'GlassHome1.launcher', 'ed.apps.launch fallback');
  await tv.launch('../etc').then(() => ok(false, 'bad app'), e => ok(e.code === 'bad-app', 'bad app ids rejected'));

  // denied: no automatic retry; Retry (pair()) tries again
  tv.close(); TV.mode = 'deny';
  const tv3 = new R.TvRemote({ host: '127.0.0.1', wsPort, restPort, tokenFile: path.join(tmp, 'other.json'), backoff: [50] });
  tv3.pair(); await until(() => tv3.state !== 'pairing');
  ok(tv3.state === 'denied', 'ms.channel.unauthorized -> denied');
  let n = TV.urls.length;
  await tv3.key('KEY_UP').then(() => ok(false, 'deny'), e => ok(e.code === 'denied' && TV.urls.length === n, 'key presses after Deny fail fast, no new prompt'));
  tv3.close();
  // TV sends ms.channel.timeOut (prompt not answered / not shown)
  TV.mode = 'timeout';
  const tv4 = new R.TvRemote({ host: '127.0.0.1', wsPort, restPort, tokenFile: path.join(tmp, 'o4.json') });
  tv4.pair(); await until(() => tv4.state !== 'pairing');
  ok(tv4.state === 'pair-timeout' && /timed out/.test(tv4.lastError) && !tv4.token, 'ms.channel.timeOut -> pair-timeout');
  n = TV.urls.length;
  await tv4.key('KEY_UP').catch(e => ok(e.code === 'pair-timeout' && TV.urls.length === n, 'no auto re-pair on key presses after a timeout'));
  TV.mode = 'allow'; tv4.pair(); await until(() => tv4.state === 'connected');
  ok(TV.urls.length === n + 1 && tv4.token === 'T-12345', 'Retry pair (pair()) connects again and pairs');
  tv4.close();
  // Allow prompt never answered -> our own timeout
  TV.mode = 'silent';
  const tv4b = new R.TvRemote({ host: '127.0.0.1', wsPort, restPort, tokenFile: path.join(tmp, 'o4b.json'), allowTimeout: 200 });
  tv4b.pair(); await until(() => tv4b.state !== 'pairing');
  ok(tv4b.state === 'pair-timeout' && !tv4b.token, 'unanswered Allow prompt -> pair-timeout');
  tv4b.close(); TV.mode = 'allow';
  // TokenAuthSupport "false" (old TVs) -> plain ws:// on 8001; true/unknown -> wss:// on 8002
  const tv6 = new R.TvRemote({ host: '127.0.0.1', wsPort, plainPort: TV.plainPort, restPort, tokenFile: path.join(tmp, 'o6.json') });
  ok(tv6.secure() && tv6.status().transport === 'wss:' + wsPort, 'wss by default');
  tv6.tokenAuth = false; tv6.pair(); await until(() => tv6.state === 'connected');
  ok(TV.transports[TV.transports.length - 1] === 'ws', 'TokenAuthSupport false -> ws:// plain port');
  tv6.close();
  // TV off / unreachable: fail fast with backoff, quiet state changes
  const tv5 = new R.TvRemote({ host: '127.0.0.1', wsPort: 1, tokenFile, connectTimeout: 500, backoff: [400] });
  let conns = 0, events = 0; const oc = tv5.connect.bind(tv5); tv5.connect = () => { conns++; oc(); }; tv5.on('state', () => events++);
  await tv5.key('KEY_UP').then(() => ok(false, 'off'), e => ok(e.code === 'offline', 'unreachable TV -> offline'));
  const t0 = Date.now(); for (let i = 0; i < 10; i++) await tv5.key('KEY_UP').catch(() => {});
  ok(Date.now() - t0 < 100 && conns <= 2, 'presses while offline fail fast without reconnecting (' + conns + ' connects for 11 presses)');
  await wait(450); await tv5.key('KEY_UP').catch(() => {});
  ok(events <= 2, 'offline -> retry -> offline is not re-announced (' + events + ' state events)');
  tv5.setPower(false); const c2 = conns; await wait(500); ok(conns === c2, 'no background reconnects while the TV is known off');
  tv5.close();

  // Wake-on-LAN
  ok(R.normMac('AA-bb-CC-11-22-33') === 'aa:bb:cc:11:22:33' && !R.normMac('nope'), 'MAC normalised');
  const udp = dgram.createSocket('udp4'); const got = new Promise(res => udp.on('message', m => res(m)));
  await new Promise(res => udp.bind(0, '127.0.0.1', res));
  await new R.TvRemote({ mac: 'aa:bb:cc:11:22:33', tokenFile }).wake({ address: '127.0.0.1', ports: [udp.address().port] });
  const pkt = await got; udp.close();
  ok(pkt.length === 102 && pkt.slice(0, 6).equals(Buffer.alloc(6, 0xff)) && pkt.slice(96).toString('hex') === 'aabbcc112233', 'magic packet: 6x FF + 16x MAC');
  await new R.TvRemote({ tokenFile }).wake().then(() => ok(false, 'nomac'), e => ok(e.code === 'no-mac', 'no TV_MAC -> no-mac'));

  // relay routes
  TV.mode = 'allow'; rest.status = 200;
  Object.assign(process.env, { DATA_DIR: require('fs').mkdtempSync(require('os').tmpdir() + '/gh-data-'), CHATS_DIR: require('fs').mkdtempSync(require('os').tmpdir() + '/gh-chats-'), LOG: '0', TV_IP: '127.0.0.1', TV_WS_PORT: String(wsPort), TV_REST_PORT: String(restPort), TV_TOKEN_FILE: tokenFile, TV_MAC: '' });
  const relay = require('../server');
  await new Promise(r2 => relay.server.listen(0, '127.0.0.1', r2));
  const base = 'http://127.0.0.1:' + relay.server.address().port;
  const post = (p, o, ct) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': ct || 'application/json' }, body: JSON.stringify(o) }).then(async x => ({ code: x.status, j: await x.json().catch(() => ({})) }));
  let st = await (await fetch(base + '/remote/status')).json();
  ok(st.paired === true && st.host === '127.0.0.1' && st.wol === false, '/remote/status');
  let x = await post('/remote/key', { key: 'KEY_DOWN' }); ok(x.code === 200 && x.j.key === 'KEY_DOWN', 'POST /remote/key');
  x = await post('/remote/key', { key: 'rm -rf' }); ok(x.code === 400, 'non-whitelisted key -> 400');
  x = await post('/remote/key', { key: 'KEY_UP' }, 'text/plain'); ok(x.code === 415, 'non-JSON body -> 415 (no cross-site posts)');
  x = await fetch(base + '/remote/key', { method: 'OPTIONS' }); ok(x.status === 403, 'no CORS preflight for /remote/*');
  const apps = await (await fetch(base + '/remote/apps')).json();
  ok(apps.apps.length >= 6 && apps.apps[0].appId && apps.launcher.appId === 'GlassHome1.launcher', '/remote/apps lists dock apps from the TV app config');
  const dockSnap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dock-apps.json'), 'utf8'));
  // since the post-v6.1 TV fix the snapshot (what the deployed relay uses for REST launches) may carry the app's Samsung store id
  // instead of tizenIds[0]; anything else must match js/config.js + js/apps.js exactly
  const APPS = (() => { const w = {}, f = path.join(__dirname, '..', '..', 'js', 'apps.js'); if (!fs.existsSync(f)) return {};   // deployed relay: no ../js, /remote/apps is the snapshot itself
    require('vm').runInNewContext(fs.readFileSync(f, 'utf8'), { window: w }); return w.RH_APPS || {}; })();
  const sameApp = (s, g) => s && g && JSON.stringify(Object.assign({}, s, { appId: 0 })) === JSON.stringify(Object.assign({}, g, { appId: 0 })) &&
    (s.appId === g.appId || ((APPS[g.key] || {}).storeIds || []).indexOf(s.appId) >= 0);
  ok(dockSnap.apps.length === apps.apps.length && apps.apps.every((g, i) => sameApp(dockSnap.apps[i], g)), 'dock-apps.json snapshot matches js/config.js + js/apps.js (appId = tizen id or store id; run node relay/dock-apps.js --write if not)');
  x = await post('/remote/launch', { app: 'netflix' }); ok(x.code === 200 && x.j.via === 'rest' && rest.calls.pop() === 'POST /api/v2/applications/' + apps.apps.filter(a => a.key === 'netflix')[0].appId, 'POST /remote/launch dock app');
  x = await post('/remote/launch', { app: 'launcher' }); ok(x.code === 200 && rest.calls.pop() === 'POST /api/v2/applications/GlassHome1.launcher', 'Home launcher button launches GlassHome1.launcher');
  x = await post('/remote/launch', { app: 'org.evil.app' }); ok(x.code === 400, 'only dock apps can be launched');
  x = await post('/remote/power', { action: 'on' }); ok(x.code === 409 && x.j.error === 'no-mac', 'power-on without TV_MAC -> hint');
  x = await post('/remote/pair', {}); ok(x.code === 200 && x.j.status && x.j.status.paired, 'POST /remote/pair returns at once with status');
  x = await post('/remote/launcher', { action: 'yoyo' }); ok(x.code === 409, 'launcher action needs the launcher connected');
  let limited = 0; for (let i = 0; i < 40; i++) { const y = await post('/remote/key', { key: 'KEY_RIGHT' }); if (y.code === 429) limited++; }
  ok(limited > 0, 'rate limited (' + limited + '/40 rejected in a burst)');
  relay.tv.close(); relay.server.close(); tv2.close(); TV.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('tv-remote: ' + pass + ' passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
