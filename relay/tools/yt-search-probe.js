#!/usr/bin/env node
'use strict';
// Glass Home: try the YouTube "search and play the top result" remote sequence on the real TV, step by step, and log
// every key, wait and TV event (ms.remote.imeStart/imeEnd = the TV's system keyboard opened/closed).
//   node tools/yt-search-probe.js '<query>' [--step] [--dry] [--type=auto|ime|grid] [--dial=<videoId>]
//   --step   wait for Enter before each step (q + Enter quits)       --dry   print the plan only, touch nothing
//   --type   force the typing method for this run                    --dial  also test DIAL POST /ws/apps/YouTube
//                                                                            without and with the Origin header
// Settings come from the environment (YT_* in relay/.env are read too). Uses the relay's saved TV token; prints no
// secrets. Safe to run while the relay is running (the TV accepts several remote connections).
const fs = require('fs'), path = require('path'), http = require('http'), readline = require('readline');
const ROOT = path.join(__dirname, '..');
// read relay/.env for TV_* / YT_* settings only (values never printed)
try {
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').forEach(l => {
    const m = /^\s*(?:export\s+)?((?:YT|TV|NETFLIX)_[A-Z0-9_]+)=(.*)$/.exec(l); if (!m || process.env[m[1]] !== undefined) return;
    process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  });
} catch (e) {}
const args = process.argv.slice(2), flag = n => args.some(a => a === '--' + n || a.indexOf('--' + n + '=') === 0), val = n => { const a = args.find(x => x.indexOf('--' + n + '=') === 0); return a ? a.slice(n.length + 3) : null; };
const query = args.filter(a => a.indexOf('--') !== 0).join(' ').trim();
if (!query && !flag('dial')) { console.log("usage: node tools/yt-search-probe.js '<query>' [--step] [--dry] [--type=auto|ime|grid] [--dial=<videoId>]"); process.exit(2); }
if (val('type')) process.env.YT_TYPE = val('type');
const YT = require('../yt-search'), { TvRemote } = require('../tv-remote');
const t0 = Date.now(), log = s => console.log(('+' + ((Date.now() - t0) / 1000).toFixed(1) + 's').padStart(8) + '  ' + s);
const c = YT.cfg(), host = process.env.TV_IP || '', appId = c.appId || '9Ur5IzDKqV.TizenYouTube';
console.log('Glass Home YouTube search probe \u00b7 TV ' + host + ' \u00b7 app ' + appId);
console.log('settings: ' + ['YT_SEARCH_KEYS=' + c.searchKeys, 'YT_TYPE=' + c.type, 'YT_SUBMIT_KEYS=' + c.submitKeys, 'YT_PLAY_KEYS=' + c.playKeys, 'YT_KEYBOARD=' + c.keyboard, 'YT_KB_START=' + c.kbStart,
  'YT_LAUNCH_WAIT_MS=' + c.launchWait, 'YT_PROFILE_ENTER=' + (c.profileEnter ? 1 : 0), 'YT_KEY_GAP_MS=' + c.keyGap, 'YT_KB_GAP_MS=' + c.kbGap].join('  '));

function dialPost(withOrigin, id) {
  return new Promise(res => {
    const body = Buffer.from('v=' + id), headers = { 'Content-Type': 'text/plain; charset="utf-8"', 'Content-Length': body.length };
    if (withOrigin) headers.Origin = process.env.YT_DIAL_ORIGIN || 'https://www.youtube.com';
    const r = http.request({ host, port: +(process.env.TV_DIAL_PORT || 8080), path: '/ws/apps/YouTube', method: 'POST', headers, timeout: 6000 }, rs => { rs.resume(); rs.on('end', () => res(rs.statusCode)); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', e => res(e.message)); r.end(body);
  });
}
function dialGet() {
  return new Promise(res => http.get({ host, port: +(process.env.TV_DIAL_PORT || 8080), path: '/ws/apps/YouTube', timeout: 4000 }, rs => { let b = ''; rs.on('data', d => b += d); rs.on('end', () => { const m = /<state>([^<]+)</.exec(b); res(rs.statusCode + (m ? ' state=' + m[1] : '')); }); }).on('error', e => res(e.message)));
}

(async () => {
  if (flag('dry')) {
    for (const st of [null, { running: true, visible: true }]) {
      const p = YT.plan(query, st);
      console.log('\nplan when YouTube is ' + (st ? 'already on screen' : 'not running') + ':');
      p.steps.forEach(s => console.log('   ' + (s.key ? 'key ' + s.key : s.wait != null ? 'wait ' + s.wait + ' ms' : s.step) + (s.label ? '  \u00b7 ' + s.label : '')));
    }
    const text = YT.normalize(query, c.keyboard), g = YT.gridKeys(text.slice(0, c.kbMax), c.keyboard, c.kbStart);
    console.log('\nkeyboard-grid typing of "' + g.text + '": ' + g.keys.length + ' keys: ' + g.keys.map(k => k.slice(4)).join(' '));
    return process.exit(0);
  }
  const tv = new TvRemote({ host, wsPort: +process.env.TV_WS_PORT || undefined, restPort: +process.env.TV_REST_PORT || undefined, name: process.env.TV_REMOTE_NAME || 'Glass Home Remote', tokenFile: process.env.TV_TOKEN_FILE || path.join(ROOT, '.secrets', 'tv-token.json'), wsMode: process.env.TV_WS_MODE || 'auto', autoPair: false });
  tv.on('message', m => { if (m.event === 'ms.channel.connect') return log('[tv] connected'); if (!/^ed\.edenTV|^ms\.channel\.(clientConnect|clientDisconnect)|^ms\.remote\.ime/.test(m.event || '')) log('[tv] ' + (m.event || m.method || 'message') + (m.data && typeof m.data !== 'object' ? ' ' + String(m.data).slice(0, 60) : '')); });
  if (flag('dial')) {
    const id = val('dial') || 'dQw4w9WgXcQ';
    log('DIAL GET /ws/apps/YouTube -> ' + await dialGet());
    log('DIAL POST v=' + id + ' without Origin -> ' + await dialPost(false, id));
    await new Promise(r => setTimeout(r, 1500));
    log('DIAL POST v=' + id + ' with Origin -> ' + await dialPost(true, id) + '   (watch the TV: did that video play?)');
    if (!query) { tv.close(); return process.exit(0); }
    await new Promise(r => setTimeout(r, 6000));
  }
  if (!tv.token) { console.log('No saved TV token: pair the relay first (phone \u203a Remote, accept on the TV).'); process.exit(1); }
  try { await tv.ready(); } catch (e) { console.log('Remote connection failed: ' + e.message); process.exit(1); }
  const rl = flag('step') ? readline.createInterface({ input: process.stdin }) : null;
  const ask = q => new Promise(r => { process.stdout.write(q); rl.once('line', l => r(l.trim())); });
  const r = await YT.run(tv, query, {
    appId, log,
    beforeStep: rl ? async s => {
      const what = s.key ? 'key ' + s.key : s.wait != null ? 'wait ' + s.wait + ' ms' : s.step;
      if (s.step === 'ime-listen') return;
      const a = await ask('          next: ' + what + (s.label ? ' (' + s.label + ')' : '') + '  [Enter = go, q = quit] ');
      if (a === 'q') { tv.close(); process.exit(0); }
    } : null
  });
  log('result: ' + (r.ok ? 'done' : 'stopped (' + r.error + ')') + ' \u00b7 typed via ' + r.method + (r.typed ? ' "' + r.typed + '"' : '') + ' \u00b7 ' + r.keys + ' keys \u00b7 IME events: ' + (r.ime.map(x => x.ev).join(', ') || 'none'));
  if (!r.ime.length) log('no IME events: YouTube used its own keyboard (expected). If letters landed wrong, set YT_KEYBOARD / YT_KB_START to what the TV shows.');
  if (rl) rl.close(); tv.close(); process.exit(r.ok ? 0 : 1);
})().catch(e => { console.error('probe failed: ' + e.message); process.exit(1); });
