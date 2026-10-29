'use strict';
// Fake Samsung TV for tests/previews: TLS WebSocket remote API (self-signed cert generated with openssl in a temp dir)
// + REST app API. Never used by the real relay.
const tls = require('tls'), net = require('net'), http = require('http'), crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { decodeFrames } = require('../tv-remote');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function srvFrame(text, op) { const p = Buffer.from(text); const h = p.length < 126 ? Buffer.from([0x80 | (op || 1), p.length]) : Buffer.from([0x80 | (op || 1), 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); }
async function start(o) {
  o = o || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faketv-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '1', '-subj', '/CN=FakeTV'], { stdio: 'ignore' });
  const TV = { mode: o.mode || 'allow', token: o.token || 'T-12345', allowDelay: o.allowDelay || 80, conns: [], urls: [], frames: [], pongs: [], unmasked: 0, headers: [], rest: { status: 200, calls: [] }, tmp, srvFrame,
    power: o.power || 'on', tokenAuth: o.tokenAuth == null ? true : o.tokenAuth, running: {}, model: 'QN75QN90AAFXZA' };
  const onSock = s => {
    let head = Buffer.alloc(0), up = false, buf = Buffer.alloc(0);
    TV.conns.push(s); s.on('error', () => {});
    s.on('data', d => {
      if (!up) {
        head = Buffer.concat([head, d]); const i = head.indexOf('\r\n\r\n'); if (i < 0) return;
        const lines = head.slice(0, i).toString().split('\r\n'), hdr = {};
        lines.slice(1).forEach(l => { const c = l.indexOf(':'); hdr[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim(); });
        TV.headers.push(hdr);
        const url = lines[0].split(' ')[1]; TV.urls.push(url); (TV.transports = TV.transports || []).push(s.secure ? 'wss' : 'ws'); up = true;
        s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(hdr['sec-websocket-key'] + GUID).digest('base64') + '\r\n\r\n');
        const q = new URL('http://x' + url).searchParams;
        s.write(srvFrame(JSON.stringify({ event: 'ed.edenTV.update', data: {} })));     // noise the client must ignore
        if (TV.mode === 'deny') return setTimeout(() => s.write(srvFrame(JSON.stringify({ event: 'ms.channel.unauthorized' }))), 30);
        if (TV.mode === 'silent') return;
        if (TV.mode === 'timeout') return setTimeout(() => s.write(srvFrame(JSON.stringify({ event: 'ms.channel.timeOut' }))), 40);
        const token = q.get('token');
        if (token && token !== TV.token) return s.write(srvFrame(JSON.stringify({ event: 'ms.channel.unauthorized' })));
        const msg = JSON.stringify({ event: 'ms.channel.connect', data: { id: 'x', clients: [], token: token ? undefined : TV.token } });
        // first time: the connect event arrives fragmented (2 frames) after the "Allow" delay
        setTimeout(() => { if (token) s.write(srvFrame(msg)); else { const h = msg.length >> 1; s.write(Buffer.concat([Buffer.from([0x01, h]), Buffer.from(msg.slice(0, h))])); s.write(Buffer.concat([Buffer.from([0x80, msg.length - h]), Buffer.from(msg.slice(h))])); } }, token ? 5 : TV.allowDelay);
        d = head.slice(i + 4); if (!d.length) return;
      }
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && !(buf[1] & 0x80)) TV.unmasked++;
      const r = decodeFrames(buf); buf = r.rest;
      r.frames.forEach(f => { if (f.opcode === 0xA) TV.pongs.push(f.payload.toString()); else if (f.opcode === 1) TV.frames.push(JSON.parse(f.payload.toString())); });
    });
  };
  TV.wss = tls.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, s => { s.secure = true; onSock(s); });
  TV.ws = net.createServer(s => { s.secure = false; onSock(s); });      // plain ws:// (port 8001 on old TVs)
  // REST like a 2021 Tizen TV. power: 'on' | 'standby' | 'down' (down = no answer, like a sleeping TV off the network)
  TV.restSrv = http.createServer((req, res) => {
    if (TV.power === 'down') return req.socket.destroy();
    TV.rest.calls.push(req.method + ' ' + req.url);
    if (req.method === 'GET' && req.url === '/api/v2/') { res.writeHead(200); return res.end(JSON.stringify({ device: { PowerState: TV.power, TokenAuthSupport: String(TV.tokenAuth), modelName: TV.model }, name: '[TV] Fake', type: 'Samsung SmartTV' })); }
    const m = /^\/api\/v2\/applications\/([^/?]+)$/.exec(req.url);
    if (m && req.method === 'GET') { res.writeHead(200); return res.end(JSON.stringify({ id: m[1], name: m[1], running: !!TV.running[m[1]], visible: !!TV.running[m[1]], version: '1.0' })); }
    if (m && req.method === 'POST' && TV.rest.status === 200) { Object.keys(TV.running).forEach(k => TV.running[k] = false); TV.running[decodeURIComponent(m[1])] = true; }
    res.writeHead(TV.rest.status); res.end(TV.rest.status === 200 ? 'true' : 'nope');
  });
  await new Promise(r => TV.wss.listen(0, '127.0.0.1', r)); await new Promise(r => TV.ws.listen(0, '127.0.0.1', r)); await new Promise(r => TV.restSrv.listen(0, '127.0.0.1', r));
  TV.wsPort = TV.wss.address().port; TV.plainPort = TV.ws.address().port; TV.restPort = TV.restSrv.address().port;
  TV.close = () => { TV.conns.forEach(c => c.destroy()); TV.wss.close(); TV.ws.close(); TV.restSrv.close(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return TV;
}
module.exports = { start, srvFrame };
