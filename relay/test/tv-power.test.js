'use strict';
// Power watch + auto-open of the launcher, against the fake Samsung TV (REST /api/v2/ PowerState, /applications/<id>).
// Steps the watcher by hand (probe -> observe) so transitions are deterministic; one timer-driven run at the end.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { TvRemote } = require('../tv-remote'), { TvPower } = require('../tv-power'), FAKE = require('./fake-tv');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok  ' + m); };
const L = 'GlassHome1.launcher', NF = 'org.tizen.netflix-app';

(async () => {
  const TV = await FAKE.start(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvpower-'));
  const mk = (o) => {
    const tv = new TvRemote({ host: '127.0.0.1', wsPort: TV.wsPort, restPort: TV.restPort, tokenFile: path.join(tmp, 'none.json'), restTimeout: 500 });
    const logs = []; const pw = new TvPower(tv, Object.assign({ settleMs: 0, offConfirm: 3, timeout: 300, log: m => logs.push(m) }, o));
    const launched = []; pw.on('launch', (r, why) => launched.push(why));
    return { tv, pw, logs, launched };
  };
  const step = async (pw, n) => { for (let i = 0; i < (n || 1); i++) await pw.observe(await pw.probe()); await wait(80); };
  const launches = () => TV.rest.calls.filter(c => c === 'POST /api/v2/applications/' + L).length;

  // 1. relay starts while the TV is on and the launcher isn't running -> opened once
  TV.power = 'on'; TV.running = { [NF]: true };
  let a = mk();
  await step(a.pw);
  ok(a.pw.power === 'on' && a.launched.join() === 'relay start' && TV.running[L], 'relay start + TV on + launcher not running -> launcher opened once');
  ok(a.pw.info.model === 'QN75QN90AAFXZA' && a.tv.tokenAuth === true, 'reads model + TokenAuthSupport from /api/v2/');
  ok(TV.urls.length === 0, 'REST launch needs no pairing (no WebSocket opened)');
  // 2. no transition: TV stays on, user switches to Netflix -> left alone
  TV.running = { [NF]: true }; const before = launches();
  await step(a.pw, 5);
  ok(launches() === before && a.launched.length === 1, 'TV stays on and user switches apps -> no relaunch');
  // 3. standby -> on -> opened after the settle delay
  TV.power = 'standby'; await step(a.pw);
  ok(a.pw.power === 'off', 'PowerState standby -> off immediately');
  TV.power = 'on'; TV.running = {}; await step(a.pw);
  ok(a.launched.slice(-1)[0] === 'power on' && TV.running[L], 'off -> on transition opens the launcher');
  // 4. on transition while the launcher is already running -> no relaunch
  TV.power = 'standby'; await step(a.pw); TV.power = 'on'; TV.running = { [L]: true }; const b4 = launches();
  let skipped = 0; a.pw.on('skip', () => skipped++);
  await step(a.pw);
  ok(launches() === b4 && skipped === 1, 'launcher already running (GET applications/<id> running:true) -> not relaunched');
  // 5. one or two missed polls (Wi-Fi blip) are not a power cycle
  TV.running = { [NF]: true }; const b5 = launches();
  TV.power = 'down'; await step(a.pw, 2); TV.power = 'on'; await step(a.pw, 2);
  ok(a.pw.power === 'on' && launches() === b5, 'two unreachable polls then on -> treated as still on, no relaunch');
  // 6. unreachable for offConfirm polls -> off; back -> on -> opened
  TV.power = 'down'; await step(a.pw, 3);
  ok(a.pw.power === 'off' && a.tv.powerOff, '3 unreachable polls -> off (remote fails fast)');
  TV.power = 'on'; TV.running = {}; await step(a.pw);
  ok(launches() === b5 + 1 && !a.tv.powerOff, 'unreachable -> on opens the launcher again');
  // 7. quiet logging: many unreachable polls -> one line
  const n0 = a.logs.length; TV.power = 'down'; await step(a.pw, 12);
  ok(a.logs.length - n0 === 1 && a.logs[a.logs.length - 1] === 'tv power off (QN75QN90AAFXZA)', 'quiet log: 12 failed polls -> one "tv power off" line');
  a.pw.stop(); a.tv.close();
  // 8. startup launch only once: relay start with launcher running -> nothing; later polls don't retry it
  TV.power = 'on'; TV.running = { [L]: true }; const b8 = launches();
  a = mk(); await step(a.pw); TV.running = {}; await step(a.pw, 3);
  ok(launches() === b8 && a.launched.length === 0, 'relay start with launcher already running -> nothing; no later launch without a transition');
  a.pw.stop(); a.tv.close();
  // 9. relay start while TV off -> no launch until it turns on
  TV.power = 'standby'; a = mk(); await step(a.pw); ok(a.pw.power === 'off' && a.launched.length === 0, 'relay start with TV off -> waits');
  TV.power = 'on'; TV.running = {}; await step(a.pw); ok(a.launched.join() === 'power on', '... then opens on power-on');
  a.pw.stop(); a.tv.close();
  // 10. AUTO_LAUNCH off
  TV.power = 'standby'; a = mk({ autoLaunch: false }); await step(a.pw); TV.power = 'on'; TV.running = {}; const b10 = launches(); await step(a.pw);
  ok(a.pw.power === 'on' && launches() === b10, 'autoLaunch:false -> watches power but never launches');
  a.pw.stop(); a.tv.close();
  // 11. REST launch refused and not paired -> gives up, never starts pairing
  TV.power = 'standby'; a = mk(); await step(a.pw); TV.rest.status = 500; TV.power = 'on'; TV.running = {}; const u11 = TV.urls.length;
  let failed = 0; a.pw.on('launch-failed', () => failed++); await step(a.pw);
  ok(failed === 1 && TV.urls.length === u11 && a.tv.state === 'unpaired', 'REST launch fails while unpaired -> no WebSocket / no Allow prompt');
  TV.rest.status = 200; a.pw.stop(); a.tv.close();
  // 12. settle delay respected, and a TV that goes back off during it isn't launched on
  TV.power = 'standby'; a = mk({ settleMs: 300 }); await step(a.pw); TV.power = 'on'; TV.running = {}; const b12 = launches();
  await step(a.pw); ok(launches() === b12, 'waits the settle delay before launching');
  await wait(320); ok(launches() === b12 + 1, '... then launches');
  a.pw.stop(); a.tv.close();
  // 13. timer-driven end to end
  TV.power = 'standby'; a = mk({ pollMs: 40, settleMs: 50 }); a.pw.start(); await wait(120);
  TV.power = 'on'; TV.running = {}; const t0 = Date.now(); while (!a.launched.length && Date.now() - t0 < 2000) await wait(20);
  ok(a.launched.join() === 'power on' && a.logs.join('|') === 'tv power off (QN75QN90AAFXZA)|tv power on (QN75QN90AAFXZA)|opened ' + L + ' (power on, rest)', 'polling loop: off -> on -> opened (log: ' + a.logs.join(' | ') + ')');
  a.pw.stop(); a.tv.close();

  // 14. relay: log lines while the TV is off and the phone hammers keys
  const lines = []; const cl = console.log; console.log = (...x) => lines.push(x.join(' '));
  TV.power = 'down';
  const tok = path.join(tmp, 'paired.json'); fs.writeFileSync(tok, JSON.stringify({ token: 'T-12345' }));
  Object.assign(process.env, { LOG: '1', TV_IP: '127.0.0.1', TV_WS_PORT: '1', TV_REST_PORT: String(TV.restPort), TV_TOKEN_FILE: tok, TV_POLL_MS: '60', AUTO_LAUNCH_DELAY_MS: '0', MOCK: '1' });
  const relay = require('../server');
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r)); relay.tvPower.start();
  const base = 'http://127.0.0.1:' + relay.server.address().port;
  for (let i = 0; i < 20; i++) { await fetch(base + '/remote/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":"KEY_UP"}' }); await wait(100); }
  const st = await (await fetch(base + '/remote/status')).json();
  console.log = cl;
  const tvl = lines.filter(l => /tv (remote|power)/.test(l));
  ok(st.power === 'off' && tvl.length <= 3, 'relay log while TV is off and 20 presses: ' + tvl.length + ' lines (' + tvl.map(l => l.replace(/^\[[^\]]+\] /, '')).join(' | ') + ')');
  relay.tvPower.stop(); relay.tv.close(); relay.server.close();
  TV.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('tv-power: ' + pass + ' passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
