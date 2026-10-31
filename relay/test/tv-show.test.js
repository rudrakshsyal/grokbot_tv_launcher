'use strict';
// v6.2 "Show on TV" against the fake TV only: POST /tv/show -> remembers the visible app (REST appStatus), launches the
// launcher, pushes a tv-show event over SSE (+ pending replay for a launcher that connects late), /tv/shown ack, /tv/back.
// Also: chat messages carry ids and /ask returns messageId. No network, no keys, no LLM calls.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const FAKE = require('./fake-tv');
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LLM_API_KEY', 'TMDB_API_KEY', 'TMDB_READ_TOKEN', 'OMDB_API_KEY', 'YT_API_KEY', 'STT_GEMINI_KEY']) delete process.env[k];
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok  ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const DOCK = require('../dock-apps'), NETFLIX = DOCK.load().apps.filter(a => a.key === 'netflix')[0].appId, L = DOCK.load().launcher.appId;

function sse(base) {   // tiny EventSource: collects parsed data: lines
  const evs = []; let req;
  const p = new Promise(r => { req = http.get(base + '/events', res => { let buf = ''; res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2);
    blk.split('\n').forEach(l => { if (l.indexOf('data: ') === 0) evs.push(JSON.parse(l.slice(6))); }); } }); r(); }); });
  return { evs, ready: p, close: () => req.destroy() };
}
async function until(f, ms) { const t0 = Date.now(); while (!f() && Date.now() - t0 < (ms || 2000)) await wait(15); return f(); }

(async () => {
  const TV = await FAKE.start();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tvshow-'));
  Object.assign(process.env, { DATA_DIR: data, CHATS_DIR: path.join(data, 'chats'), LOG_DIR: path.join(data, 'logs'), METRICS_DIR: path.join(data, 'metrics'), LOG: '0',
    TV_IP: '127.0.0.1', TV_WS_PORT: '1', TV_PLAIN_WS_PORT: '1', TV_REST_PORT: String(TV.restPort), TV_TOKEN_FILE: path.join(data, 'none.json'), TV_POLL: '0', TV_AUTOCONNECT: '0' });
  const CH = require('../chats'), TVS = require('../tv-show');
  const relay = require('../server');
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  const rb = 'http://127.0.0.1:' + relay.server.address().port;
  const post = async (p, o, type) => { await wait(260);   // stay under the relay's per-IP rate limit (12/s, /tv/show costs 3)
 const r = await fetch(rb + p, { method: 'POST', headers: { 'Content-Type': type || 'application/json' }, body: JSON.stringify(o || {}) }); return { code: r.status, j: await r.json().catch(() => ({})) }; };
  const launches = () => TV.events.filter(e => /^launch /.test(e));

  // 1. message ids
  const c = CH.create({ client: 't' });
  CH.addMessage(c, { role: 'user', text: 'Explain how a heat pump works' });
  const LONG = 'A heat pump moves heat instead of making it. '.repeat(20).trim();
  const am = CH.addMessage(c, { role: 'assistant', text: LONG, brain: 'built-in' });
  ok(am && /^m[a-z0-9]+$/.test(am.id) && CH.get(c.id).messages[0].id && CH.get(c.id).messages[0].id !== am.id, 'addMessage returns the message with a unique id (' + am.id + ')');
  ok(CH.findMessage(c, am.id).index === 1 && CH.findMessage(c, null, 1).msg === am && !CH.findMessage(c, 'mnope') && !CH.findMessage(c, null, 9) && !CH.findMessage(c, null, -1), 'findMessage by id, by index; misses are null');

  const tvA = sse(rb); await tvA.ready; await wait(30);
  // 2. Netflix visible -> remembers it, opens the launcher, pushes the answer
  TV.running = {}; TV.running[NETFLIX] = true; const l0 = launches().length;
  let r = await post('/tv/show', { chatId: c.id, messageId: am.id });
  ok(r.code === 200 && r.j.ok && r.j.launcher === 'launched' && r.j.via === 'rest' && r.j.previous && r.j.previous.key === 'netflix' && r.j.previous.name === 'Netflix', 'show while Netflix is on screen -> 200, launched via REST, previous = Netflix');
  ok(launches().length === l0 + 1 && launches()[launches().length - 1] === 'launch ' + L, 'the launcher (' + L + ') was launched once, nothing else');
  ok(TV.events.filter(e => /^key /.test(e)).length === 0, 'no remote keys were pressed');
  await until(() => tvA.evs.some(e => e.type === 'tv-show'));
  let ev = tvA.evs.filter(e => e.type === 'tv-show')[0];
  ok(ev && ev.id === r.j.id && ev.text === LONG && ev.question === 'Explain how a heat pump works' && ev.prev && ev.prev.key === 'netflix' && ev.messageId === am.id && ev.chatId === c.id, 'SSE push: tv-show with question, full text, prev app, ids');
  const firstId = r.j.id;
  // 3. pending: replayed to a launcher that connects late, readable via GET, cleared by the ack
  const tvB = sse(rb); await tvB.ready; await until(() => tvB.evs.length > 0, 1000);
  ok(tvB.evs.length === 1 && tvB.evs[0].type === 'tv-show' && tvB.evs[0].id === firstId && tvB.evs[0].replay === true, 'a launcher connecting after the push gets the pending show replayed');
  let pend = await (await fetch(rb + '/tv/pending')).json();
  ok(pend.pending && pend.pending.id === firstId, 'GET /tv/pending returns it');
  r = await post('/tv/shown', { id: 'swrong' }, 'text/plain;charset=UTF-8'); ok(r.code === 200 && r.j.ok === false, '/tv/shown with a wrong id -> ok:false');
  r = await post('/tv/shown', { id: firstId }, 'text/plain;charset=UTF-8'); ok(r.code === 200 && r.j.ok === true, '/tv/shown (text/plain from the launcher, no preflight) acks it');
  pend = await (await fetch(rb + '/tv/pending')).json(); ok(pend.pending === null, '... and the pending show is cleared');
  const tvC = sse(rb); await tvC.ready; await wait(80); ok(tvC.evs.length === 0, 'a launcher connecting after the ack gets nothing'); tvC.close();
  // 4. Back to Netflix
  r = await post('/tv/back', { id: 'sbogus' }, 'text/plain'); ok(r.code === 404 && r.j.error === 'no-show', '/tv/back with an unknown id -> 404');
  const l1 = launches().length;
  r = await post('/tv/back', { id: firstId }, 'text/plain');
  ok(r.code === 200 && r.j.app === 'netflix' && launches().length === l1 + 1 && launches()[launches().length - 1] === 'launch ' + NETFLIX, '/tv/back relaunches Netflix (REST launch of ' + NETFLIX + ')');
  // 5. launcher already in front -> no launch, no previous app
  TV.running = {}; TV.running[L] = true; const l2 = launches().length;
  r = await post('/tv/show', { chatId: c.id, messageId: am.id });
  ok(r.code === 200 && r.j.launcher === 'front' && r.j.previous === null && launches().length === l2, 'Home already visible -> pushes without launching anything');
  await until(() => tvA.evs.filter(e => e.type === 'tv-show').length === 2);
  ok(tvA.evs.filter(e => e.type === 'tv-show')[1].prev === null, '... and the push has no "Back to" app');
  r = await post('/tv/back', { id: r.j.id }, 'text/plain'); ok(r.code === 409 && r.j.error === 'no-previous', '/tv/back without a remembered app -> 409');
  // 6. nothing visible (e.g. TV on a HDMI input or the app list) -> launches, previous null
  TV.running = {}; r = await post('/tv/show', { chatId: c.id, messageId: am.id });
  ok(r.code === 200 && r.j.launcher === 'launched' && r.j.previous === null, 'no dock app visible -> launches Home, previous null');
  // 7. legacy message without id -> by index
  const legacy = CH.get(c.id); legacy.messages.push({ role: 'assistant', text: 'Old answer from v6.1', ts: Date.now() }); CH.save(legacy);
  r = await post('/tv/show', { chatId: c.id, index: legacy.messages.length - 1 });
  ok(r.code === 200 && r.j.ok, 'a v6.1 message without id can be shown by index');
  // 8. refusals
  r = await post('/tv/show', { chatId: c.id, messageId: CH.get(c.id).messages[0].id }); ok(r.code === 404 && r.j.error === 'no-message', 'a user message -> 404 no-message');
  r = await post('/tv/show', { chatId: c.id, messageId: 'mnothere' }); ok(r.code === 404, 'unknown messageId -> 404');
  r = await post('/tv/show', { chatId: 'x/../etc', messageId: am.id }); ok(r.code === 400 && r.j.error === 'bad-chat', 'bad chat id -> 400');
  r = await post('/tv/show', { chatId: 'c0000000000', messageId: am.id }); ok(r.code === 404 && r.j.error === 'no-chat', 'unknown chat -> 404');
  r = await post('/tv/show', { chatId: c.id, messageId: am.id }, 'text/plain'); ok(r.code === 415, '/tv/show with text/plain -> 415 (needs JSON: cross-site pages can\u2019t trigger it)');
  let o = await fetch(rb + '/tv/show', { method: 'OPTIONS' }); ok(o.status === 403, 'CORS preflight to /tv/show -> 403');
  o = await fetch(rb + '/tv/show'); ok(o.status === 404, 'GET /tv/show -> 404');
  const before = tvA.evs.length;
  relay.tvPower.power = 'off'; r = await post('/tv/show', { chatId: c.id, messageId: am.id }); relay.tvPower.power = 'unknown';
  ok(r.code === 409 && r.j.error === 'tv-off', 'TV known to be off -> 409 tv-off');
  TV.running = {}; TV.rest.status = 500; const l3 = launches().length;
  r = await post('/tv/show', { chatId: c.id, messageId: am.id }); TV.rest.status = 200;
  ok(r.code === 503 && launches().length === l3 && TV.urls.length === 0, 'REST launch refused and not paired -> 503, no WebSocket/pairing prompt');
  await wait(60); ok(tvA.evs.length === before, 'failed shows push nothing to the TV');
  // 9. /ask returns the stored message id, the answer event carries it
  const n0 = tvA.evs.length;
  const a = await (await fetch(rb + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello', client: 'tvshow-test', chatId: c.id }) })).json();
  const stored = CH.get(c.id).messages; const lastMsg = stored[stored.length - 1];
  ok(a.messageId && lastMsg.role === 'assistant' && lastMsg.id === a.messageId, '/ask returns messageId of the stored answer (' + a.messageId + ')');
  await until(() => tvA.evs.slice(n0).some(e => e.type === 'answer'));
  const ansEv = tvA.evs.slice(n0).filter(e => e.type === 'answer')[0];
  ok(ansEv && ansEv.messageId === a.messageId && ansEv.chatId === c.id, 'the SSE answer event carries messageId + chatId');
  // 10. the module on its own: pending expires
  const fakeSend = []; const mod = TVS.create({ tv: relay.tv, power: { power: 'on' }, dock: require('../dock-apps'), chats: CH, send: e => fakeSend.push(e), pendingMs: 40 });
  TV.running = {}; TV.running[L] = true;
  const mr = await mod.show({ chatId: c.id, messageId: am.id });
  ok(mr[0] === 200 && fakeSend.length === 1 && mod.pending() && mod.pending().id === mr[1].id, 'module: show -> one send, pending set');
  await wait(60); ok(mod.pending() === null, 'module: pending expires after pendingMs');
  ok(TVS.isVisible({ visible: true }) && TVS.isVisible({ visible: 'true' }) && !TVS.isVisible({ visible: false, running: true }) && !TVS.isVisible(null), 'isVisible: only visible:true counts (running in the background does not)');

  tvA.close(); tvB.close();
  relay.server.close(); relay.tvPower.stop(); relay.tv.close(); TV.close(); fs.rmSync(data, { recursive: true, force: true });
  console.log('tv-show: ' + pass + ' passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
