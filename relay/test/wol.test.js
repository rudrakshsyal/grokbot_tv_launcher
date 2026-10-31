'use strict';
// Wake-on-LAN v6: targets, repeated magic packets, MAC learned from the TV's REST info (wifiMac) and saved, /remote/power.
// All packets go to 127.0.0.1 on a test UDP port (TV_WOL_ADDRS / WOL_PORTS), never to the real LAN.
const dgram = require('dgram'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const FAKE = require('./fake-tv'), R = require('../tv-remote');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok  ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wol-')), pkts = [];
  const udp = dgram.createSocket('udp4'); udp.on('message', m => pkts.push(m)); await new Promise(r => udp.bind(0, '127.0.0.1', r));
  const port = udp.address().port;
  // 1. targets
  const t = new R.TvRemote({ host: '10.9.8.7', mac: '02:00:5E:10:20:30', tokenFile: path.join(tmp, 'x.json') });
  const tg = t.wakeTargets('10.9.8.255');
  ok(tg[0] === '10.9.8.255' && tg.indexOf('255.255.255.255') >= 0 && tg[tg.length - 1] === '10.9.8.7' && new Set(tg).size === tg.length, 'targets: extra + limited broadcast (+ subnet broadcast) + TV IP, no duplicates: ' + tg.join(', '));
  ok(R.TvRemote.prototype.wakeTargets.call({ host: 'tv.local' }).join() === '255.255.255.255', 'hostname TV -> broadcast only');
  // 2. repeats
  const r = await t.wake({ addresses: ['127.0.0.1'], ports: [port], repeats: 3, gapMs: 30 }); await wait(80);
  const mac = Buffer.from('02005E102030', 'hex'), good = p => p.length === 102 && p.slice(0, 6).equals(Buffer.alloc(6, 0xff)) && p.slice(6, 12).equals(mac) && p.slice(96).equals(mac);
  ok(r.sent === 3 && pkts.length === 3 && pkts.every(good), 'repeats:3 -> 3 magic packets (6x FF + 16x MAC, 102 bytes)');
  // 3. relay learns the MAC from the TV and saves it
  const TV = await FAKE.start(); TV.power = 'on';
  Object.assign(process.env, { DATA_DIR: tmp, CHATS_DIR: path.join(tmp, 'chats'), METRICS_DIR: tmp, METRICS: '0', LOG: '0', LLM: 'off', GEMINI_API_KEY: '', TV_MAC: '', TV_IP: '127.0.0.1',
    TV_WS_PORT: '1', TV_REST_PORT: String(TV.restPort), TV_TOKEN_FILE: path.join(tmp, 'none.json'), TV_POLL_MS: '60', AUTO_LAUNCH: '0', TV_WOL_ADDRS: '127.0.0.1', WOL_PORTS: String(port), WOL_REPEATS: '2' });
  const relay = require('../server');
  await new Promise(z => relay.server.listen(0, '127.0.0.1', z));
  const base = 'http://127.0.0.1:' + relay.server.address().port;
  const power = async () => { const x = await fetch(base + '/remote/power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"on"}' }); return { status: x.status, j: await x.json() }; };
  TV.power = 'standby';
  let p = await power();
  ok(p.status === 409 && p.j.error === 'no-mac' && /Turn the TV on once/.test(p.j.message), 'no MAC yet -> 409 with "turn it on once" message');
  TV.power = 'on'; relay.tvPower.start();
  for (let i = 0; i < 50 && !relay.tv.mac; i++) await wait(40);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'tv.json'), 'utf8'));
  ok(relay.tv.mac === '02:00:5e:10:20:30' && saved.mac === '02:00:5e:10:20:30' && (fs.statSync(path.join(tmp, 'tv.json')).mode & 0o777) === 0o600, 'wifiMac learned from /api/v2/ and saved to data/tv.json (mode 600)');
  const st = await (await fetch(base + '/status')).json();
  ok(st.wol && JSON.stringify(st.wol).indexOf('02:00') < 0, '/status reports WoL readiness without printing the MAC: ' + JSON.stringify(st.wol));
  // 4. TV off -> Wake-on-LAN, repeated, burst polling, hint
  TV.power = 'standby'; for (let i = 0; i < 30 && relay.tvPower.power !== 'off'; i++) await wait(40);
  pkts.length = 0; p = await power(); await wait(450);
  ok(p.status === 200 && p.j.via === 'wol' && p.j.sent === 2 && pkts.length === 2 && pkts.every(good), '/remote/power on while off -> WoL repeated (WOL_REPEATS=2, test port): ' + pkts.length + ' packets');
  ok(/Power On with Mobile/.test(p.j.hint) && relay.tvPower.status().waking, 'answer carries the "Power On with Mobile" hint; power watcher in fast-poll mode');
  relay.tvPower.stop(); relay.tv.close(); relay.server.close(); TV.close();
  // 5. relay restart: MAC comes from data/tv.json; TV_MAC wins over it
  const out = require('child_process').execFileSync(process.execPath, ['-e', "const s=require('./server');console.log(s.tv.mac);s.tvPower.stop();s.tv.close();process.exit(0)"], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { TV_MAC: '' }) }).toString().trim().split('\n').pop();
  const out2 = require('child_process').execFileSync(process.execPath, ['-e', "const s=require('./server');console.log(s.tv.mac);s.tvPower.stop();s.tv.close();process.exit(0)"], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { TV_MAC: 'aa-bb-cc-dd-ee-ff' }) }).toString().trim().split('\n').pop();
  ok(out === '02:00:5e:10:20:30' && /aa.bb.cc.dd.ee.ff/i.test(out2), 'after restart: MAC from data/tv.json; TV_MAC overrides it');
  udp.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('wol: ' + pass + ' passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
