'use strict';
// Glass Home relay: phone page (chat, mic, remote) -> brain (LLM with tools, or the free parser) -> SSE timeline to the TV.
// Zero dependencies, Node 14+.  Run: node server.js   (env vars: see README.md)
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const LLM = require('./brain-llm'), FREE = require('./brain-free'), T = require('./tools'), M = require('./metrics');
const CH = require('./chats'), PLAY = require('./play'), STT = require('./stt'), TVSHOW = require('./tv-show');
const E = process.env, PORT = +(E.PORT || 8787), MOCK = E.MOCK === '1';
const { TvPower } = require('./tv-power');
const { TvRemote, KEYS } = require('./tv-remote'), DOCK = require('./dock-apps');
// Phone remote -> Samsung TV (local WebSocket remote API on :8002, REST app launch on :8001, Wake-on-LAN). See README.md.
// TV MAC for Wake-on-LAN: TV_MAC, else the one learned from the TV's own REST info (wifiMac) and saved in data/tv.json
const DATA_DIR = E.DATA_DIR || path.join(__dirname, 'data'), TV_FILE = path.join(DATA_DIR, 'tv.json');
function savedTv() { try { return JSON.parse(fs.readFileSync(TV_FILE, 'utf8')) || {}; } catch (e) { return {}; } }
const tv = new TvRemote({ host: E.TV_IP || '', mac: E.TV_MAC || savedTv().mac || '', name: E.TV_REMOTE_NAME || 'Glass Home Remote',
  tokenFile: E.TV_TOKEN_FILE || path.join(__dirname, '.secrets', 'tv-token.json'), wsMode: E.TV_WS_MODE || 'auto',
  wsPort: +(E.TV_WS_PORT || 8002), plainPort: +(E.TV_PLAIN_WS_PORT || 8001), restPort: +(E.TV_REST_PORT || 8001) });
const tvPower = new TvPower(tv, { pollMs: +(E.TV_POLL_MS || 5000), settleMs: E.AUTO_LAUNCH_DELAY_MS != null ? +E.AUTO_LAUNCH_DELAY_MS : 4000,
  appId: E.LAUNCHER_APP_ID || 'GlassHome1.launcher', autoLaunch: E.AUTO_LAUNCH !== '0', log: m => tvlog(m) });
// Log TV state changes only (the same state is never logged twice in a row, so an off TV doesn't spam the log).
let lastTvLog = '';
function tvlog(m) { if (E.LOG !== '0' && m !== lastTvLog) { lastTvLog = m; console.log('[' + new Date().toLocaleTimeString() + '] ' + m); } }
tv.on('state', st => tvlog('tv remote ' + st.state + (st.lastError && st.state !== 'connected' ? ' \u00b7 ' + st.lastError : '')));
tvPower.on('mac', (mac, model) => {   // learned while TV_MAC is unset: remember it so the TV can be woken after a relay restart
  try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(TV_FILE, JSON.stringify({ mac, model: model || null, learned: new Date().toISOString() }), { mode: 0o600 }); } catch (e) {}
});
// Wake-on-LAN: limited broadcast + the TV subnet's broadcast + the TV's IP (+ TV_WOL_ADDR), WOL_REPEATS rounds.
// TV_WOL_ADDRS (comma list) replaces the targets entirely; WOL_PORTS overrides 9,7.
function wakeTv() {
  return tv.wake({ addresses: E.TV_WOL_ADDRS ? E.TV_WOL_ADDRS.split(',').map(x => x.trim()).filter(Boolean) : tv.wakeTargets(E.TV_WOL_ADDR || undefined),
    ports: E.WOL_PORTS ? E.WOL_PORTS.split(',').map(Number) : undefined, repeats: +(E.WOL_REPEATS || 3) });
}
PLAY.configure({ tv, power: tvPower, wake: wakeTv });
LLM.setPlayer(PLAY.run); FREE.setPlayer(PLAY.run);
const WOL_HINT = 'If the TV doesn\u2019t turn on, enable Settings \u203a General \u203a Network \u203a Expert Settings \u203a Power On with Mobile on the TV.';
tvPower.on('power', p => { if (p === 'on' && tv.token && E.TV_AUTOCONNECT !== '0' && !tv.sock && tv.state !== 'connected') { tv.lastUse = Date.now(); tv.connect(); } });
// Simple per-IP token bucket for /remote/* (D-pad repeat is ~6/s; allow short bursts).
const buckets = new Map();
function allow(ip, cost) {
  const now = Date.now(), b = buckets.get(ip) || { t: now, n: 20 };
  b.n = Math.min(20, b.n + (now - b.t) / 1000 * 12); b.t = now;
  if (b.n < (cost || 1)) { buckets.set(ip, b); return false; }
  b.n -= cost || 1; buckets.set(ip, b); if (buckets.size > 200) buckets.delete(buckets.keys().next().value); return true;
}
const LANGS = new Set(['en-US', 'hi-IN', 'en-IN']);
const LAUNCHER_ACTIONS = new Set(['yoyo', 'stats', 'close']);
const ICONS = { '/apple-touch-icon.png': 'icon-180.png', '/icon-180.png': 'icon-180.png', '/icon-512.png': 'icon-512.png', '/icon-192.png': 'icon-192.png' };

const clients = new Set(), waiters = [];
let seq = 0, current = null, lastEvents = [];
function send(ev) {
  ev.ts = Date.now();
  if (ev.type === 'start') lastEvents = [];
  lastEvents.push(ev); if (lastEvents.length > 80) lastEvents.shift();
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  clients.forEach(res => { try { res.write(line); } catch (e) {} });
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](ev)) waiters.splice(i, 1);
  if (E.LOG !== '0' && ev.type !== 'transcript') console.log('[' + new Date().toLocaleTimeString() + ']', ev.type, ev.phase || '', ev.label || ev.text || ev.message || ev.query || '', ev.detail ? '\u00b7 ' + ev.detail : '', ev.ms != null ? ev.ms + 'ms' : '');
}
// v6.2 "Show on TV" (tv-show.js): phone -> relay -> launcher brought to the front -> big answer panel
const tvShow = TVSHOW.create({ tv, power: tvPower, dock: DOCK, chats: CH, send, clients: () => clients.size, log: m => tvlog(m) });
// resolve a waiting POST /ask without broadcasting (used when its session is replaced)
function settle(ev) { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](ev)) waiters.splice(i, 1); }
function session(query) {
  if (current && !current.cancelled) {                    // a new request replaces the one on screen; its /ask is answered now, not after a 90 s timeout
    current.cancelled = true; settle({ type: 'error', session: current.id, superseded: true, message: 'Replaced by a newer question.' });
  }
  const s = { id: ++seq, cancelled: false, n: 0 };
  current = s;
  const emit = ev => { if (ev.type === 'action' && s.ctx.metrics) s.ctx.metrics.actions.push({ action: ev.action, app: ev.app }); if (!s.cancelled) send(Object.assign({ session: s.id }, ev)); };
  s.ctx = {
    emit, cancelled: () => s.cancelled,
    async step(label, fn) {
      const id = ++s.n, t0 = Date.now();
      emit({ type: 'step', id, phase: 'start', label });
      try { const d = await fn(); s.ctx.metrics && s.ctx.metrics.step(label, Date.now() - t0, 'ok'); emit({ type: 'step', id, phase: 'end', label, state: 'ok', detail: d || '', ms: Date.now() - t0 }); return d; }
      catch (e) { s.ctx.metrics && s.ctx.metrics.step(label, Date.now() - t0, 'err'); emit({ type: 'step', id, phase: 'end', label, state: 'err', detail: String(e.user || e.message || 'failed').slice(0, 90), ms: Date.now() - t0 }); throw e; }
    }
  };
  emit({ type: 'start', query });
  return s;
}
// what the phone reads aloud: plain text, no emoji/markdown/URLs/parenthesised years, at most 2 sentences
function spoken(t) {
  t = String(t || '').replace(/https?:\/\/\S+/g, '').replace(/[*_#`>~|]/g, '').replace(/\((?:19|20)\d\d\)/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B50}]/gu, '').replace(/\s+([,.!?\u0964])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  const out = t.split(/(?<=[.!?\u0964])\s+/).slice(0, 2).join(' ');
  return out.trim().slice(0, 400);
}
const slim = i => ({ title: i.title, kind: i.kind, year: i.year, poster: i.poster, imdb: i.imdb, rt: i.rt, platform: i.platform, platformName: i.platformName, runtime: i.runtime, seasons: i.seasons, genres: i.genres });

async function ask(text, o) {
  o = o || {};
  if (MOCK) return replay();
  const s = session(text), ctx = s.ctx, m = ctx.metrics = M.begin(text, o);
  const chat = o.chat || LLM.history(o.client || 'default');
  CH.addMessage(chat, { role: 'user', text, voice: o.typed ? undefined : true, lang: o.lang });
  ctx.chatId = chat.id;
  ctx.emit({ type: 'transcript', text, final: true });
  await ctx.step('Heard you', async () => '\u201c' + text + '\u201d \u00b7 ' + text.split(/\s+/).length + ' words' + (o.sttMs ? ' \u00b7 ' + (o.sttMs / 1000).toFixed(1) + ' s of speech' : '') + (o.typed ? ' \u00b7 typed' : ''));
  let ans = null;
  if (LLM.enabled()) {
    try { ans = await LLM.run(text, ctx, chat.id, { lang: o.lang }); }
    catch (e) {
      if (s.cancelled) return;
      if (!e.noLLM) {
        const why = M.reason(e);
        if (!e.budget) m.hop(e.model || 'llm', why);   // budget skips were already recorded per endpoint
        await ctx.step('Switching to free mode', async () => 'LLM ' + why + ' \u2192 built-in parser');
        console.warn('LLM failed \u2192 built-in parser (' + why + '):', String(e.message || '').slice(0, 240));
      }
    }
  }
  try {
    if (!ans) { ans = await FREE.run(text, ctx); ans.brain = 'built-in'; if (!s.cancelled) LLM.remember(chat.id, text, ans.text); }
    ans.spoken = spoken(ans.text);
    const st = M.stats(m, ans.brain);
    ans.stats = st; ans.metrics = m; M.record(m, st, { answer: ans.text.slice(0, 300), items: (ans.items || []).length });
    if (ctx.played) ans.played = ctx.played;
    ans.chatId = chat.id; ans.chatTitle = chat.title;
    const saved = !s.cancelled ? CH.addMessage(chat, { role: 'assistant', text: ans.text, brain: ans.brain, items: (ans.items || []).slice(0, 6).map(slim), played: ans.played,
      stats: { totalMs: st.totalMs, model: st.model, tokens: st.tokens } }) : null;
    if (saved) ans.messageId = saved.id;
    ctx.emit({ type: 'answer', messageId: ans.messageId, text: ans.text, items: (ans.items || []).map(slim), brain: ans.brain, spoken: ans.spoken, stats: st, played: ans.played, chatId: chat.id, chatTitle: chat.title });
    return ans;
  } catch (e) {
    const msg = e.user || 'Something went wrong (' + String(e.message || '').slice(0, 60) + ')', st = M.stats(m, null, M.reason(e));
    M.record(m, st);
    if (!s.cancelled) CH.addMessage(chat, { role: 'assistant', text: msg, brain: 'error' });
    ctx.emit({ type: 'error', message: msg, stats: st, chatId: chat.id, chatTitle: chat.title });
    return { error: msg, text: '', items: [], stats: st, metrics: m };
  }
}
// MOCK=1: replays a recorded real session (mock-session.json) with its original timings; needs no keys or network
function replay() {
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-session.json'), 'utf8'));
  const s = session(rec.query); let t = 0;
  const slow = +(E.MOCK_SLOW || 1), t0 = Date.now();
  rec.events.forEach(ev => { t += (ev.dt || 0) * slow; setTimeout(() => { const c = Object.assign({}, ev, { mock: true }); delete c.dt;
    if (c.type === 'answer' && !c.stats) c.stats = { brain: 'free', model: 'mock replay', llmCalls: 0, tokens: 'n/a', llmMs: 0, toolMs: {}, tools: 0, firstStepMs: null, totalMs: Date.now() - t0, hops: 0, fallback: null, error: null, steps: [] };
    s.ctx.emit(c); }, t); });
}

async function chats(req, res, u) {
  const m = /^\/chats(?:\/([^/]+)(?:\/(rename|delete))?)?$/.exec(u);
  if (!m) return json(res, 404, { error: 'not found' });
  const id = m[1], op = m[2];
  if (req.method === 'GET' && !id) return json(res, 200, { chats: CH.list() });
  if (req.method === 'POST' && !id) { const b = await body(req); const c = CH.create({ client: String(b.client || '').slice(0, 64) || null, title: b.title ? String(b.title).slice(0, 60) : undefined }); return json(res, 200, CH.summaryOf(c)); }
  if (!CH.validId(id)) return json(res, 400, { error: 'bad id' });
  if (req.method === 'GET' && !op) { const c = CH.get(id); if (!c) return json(res, 404, { error: 'no chat' }); return json(res, 200, Object.assign(CH.summaryOf(c), { messages: c.messages })); }
  if (req.method === 'POST' && op === 'rename') { const b = await body(req); const r = CH.rename(id, b.title); return r ? json(res, 200, r) : json(res, 404, { error: 'no chat' }); }
  if (req.method === 'POST' && op === 'delete') { LLM.LEGACY.forEach((v, k) => { if (v === id) LLM.LEGACY.delete(k); }); return json(res, 200, { ok: CH.remove(id) }); }
  json(res, 404, { error: 'not found' });
}
// POST /stt: raw audio body (Content-Type audio/mp4 | audio/wav | audio/webm ...), ?lang=en-US&sec=4.2 -> { text, engine, ms }
function stt(req, res) {
  const q = new URL(req.url, 'http://x').searchParams, max = STT.MAX_BYTES(), ip = req.socket.remoteAddress || '?';
  if (!allow('stt:' + ip, 4)) return json(res, 429, { error: 'slow down' });
  if (+(req.headers['content-length'] || 0) > max) { res.setHeader('Connection', 'close'); json(res, 413, { error: 'Recording too long.' }); return req.destroy(); }
  const chunks = []; let n = 0, over = false;
  req.on('data', c => { n += c.length; if (n > max) { over = true; req.pause(); json(res, 413, { error: 'Recording too long.' }); req.destroy(); } else chunks.push(c); });
  req.on('end', async () => {
    if (over) return;
    try {
      const r = await STT.transcribe(Buffer.concat(chunks), { mime: req.headers['content-type'], lang: LANGS.has(q.get('lang')) ? q.get('lang') : 'en-US', seconds: +q.get('sec') || null });
      json(res, 200, { text: r.text, engine: r.engine, ms: r.ms, seconds: r.seconds });
    } catch (e) { json(res, e.http || 502, { error: e.user || 'Speech-to-text failed.', engine: STT.engine() }); }
  });
}

function body(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const { URL } = require('url');
function json(res, code, o) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS)); res.end(JSON.stringify(o)); }

async function remote(req, res, u) {
  const ip = req.socket.remoteAddress || '?';
  if (req.method === 'GET' && u === '/remote/status') return json(res, 200, Object.assign(tv.status(), tvPower.status(), { launcher: clients.size > 0 }));
  if (req.method === 'GET' && u === '/remote/apps') { const d = DOCK.load(); return json(res, 200, { launcher: d.launcher, apps: d.apps }); }
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
  if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
  if (!allow(ip, u === '/remote/key' ? 1 : 3)) return json(res, 429, { error: 'slow down' });
  const b = await body(req), fail = e => json(res, e.code === 'bad-key' || e.code === 'bad-app' ? 400 : /^(no-mac|pairing|unpaired|pair-timeout|denied)$/.test(e.code) ? 409 : 503,
    { ok: false, error: e.code || 'error', message: String(e.message || '').slice(0, 160), status: tv.status() });
  try {
    if (u === '/remote/key') {
      const k = String(b.key || '').toUpperCase();
      if (k !== 'PLAYPAUSE' && !KEYS.has(k)) return json(res, 400, { ok: false, error: 'bad-key' });
      const cmd = b.cmd === 'Press' || b.cmd === 'Release' ? b.cmd : 'Click';
      return json(res, 200, { ok: true, key: await tv.key(k, cmd) });
    }
    if (u === '/remote/pair') { const st = tv.pair(); return json(res, 200, { ok: true, status: st }); }   // returns at once; the phone polls /remote/status
    if (u === '/remote/launch') {
      const d = DOCK.load(), want = String(b.app || ''), a = want === 'launcher' ? d.launcher : d.apps.filter(x => x.key === want)[0];
      if (!a) return json(res, 400, { ok: false, error: 'bad-app' });   // only dock apps and the launcher can be launched
      return json(res, 200, Object.assign({ ok: true, app: a.key }, await tv.launch(a.appId)));
    }
    if (u === '/remote/power') {
      // On (REST says PowerState on) -> KEY_POWER over the paired WebSocket. Off/standby/unreachable -> Wake-on-LAN.
      const on = tvPower.power === 'on' || tv.state === 'connected';
      if (b.action === 'on' || (b.action !== 'off' && !on)) {
        if (!tv.mac) return json(res, 409, { ok: false, error: 'no-mac', message: 'I don\u2019t know the TV\u2019s network address yet. Turn the TV on once with its remote (the relay learns it), or set TV_MAC in the relay .env.', status: tv.status() });
        const r = await wakeTv();
        tvPower.burst(+(E.WOL_WATCH_MS || 45000));   // poll every second so the phone sees "on" quickly and auto-launch kicks in
        return json(res, 200, { ok: true, via: 'wol', sent: r.sent, addresses: r.addresses.length, hint: WOL_HINT });
      }
      if (tv.state !== 'connected' && tv.token) await tv.ready(2500);
      return json(res, 200, { ok: true, key: await tv.key('KEY_POWER') });
    }
    if (u === '/remote/launcher') {   // launcher-only actions over the existing SSE channel (handled in js/voice.js)
      const a = String(b.action || '');
      if (!LAUNCHER_ACTIONS.has(a)) return json(res, 400, { ok: false, error: 'bad-action' });
      if (!clients.size) return json(res, 409, { ok: false, error: 'launcher-offline' });
      send({ type: 'remote', action: a }); return json(res, 200, { ok: true });
    }
  } catch (e) { return fail(e); }
  json(res, 404, { error: 'not found' });
}

// ---- v6.2 Show on TV ----
// /tv/show is JSON-only (a cross-site page can't send that without a CORS preflight, and preflights to /tv/ get 403).
// /tv/shown and /tv/back come from the launcher as text/plain (no preflight) and only act on the random id of a show.
async function tvRoutes(req, res, u) {
  const ip = req.socket.remoteAddress || '?';
  if (req.method === 'GET' && u === '/tv/pending') return json(res, 200, { pending: tvShow.pending() });
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
  if (!allow('tv:' + ip, u === '/tv/show' ? 3 : 1)) return json(res, 429, { error: 'slow down' });
  const ct = req.headers['content-type'] || '';
  if (u === '/tv/show') {
    if (!/application\/json/.test(ct)) return json(res, 415, { error: 'json only' });
    const r = await tvShow.show(await body(req)); return json(res, r[0], r[1]);
  }
  if (!/application\/json|text\/plain/.test(ct)) return json(res, 415, { error: 'json only' });
  if (u === '/tv/shown') { const b = await body(req); return json(res, 200, { ok: tvShow.shown(b.id) }); }
  if (u === '/tv/back') { const r = await tvShow.back((await body(req)).id); return json(res, r[0], r[1]); }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { if (u.startsWith('/remote/') || u.startsWith('/tv/')) { res.writeHead(403); return res.end(); } res.writeHead(204, CORS); return res.end(); }   // no cross-site TV control
  if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'phone.html')));
  }
  if (req.method === 'GET' && u === '/ca.crt') {
    const f = path.join(__dirname, 'certs', 'ca.crt');
    if (!fs.existsSync(f)) return json(res, 404, { error: 'no ca' });
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="GlassHome-CA.crt"' });
    return res.end(fs.readFileSync(f));
  }
  if (req.method === 'GET' && u === '/manifest.json') return json(res, 200, { name: 'Glass Home', short_name: 'Glass Home', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#07080d', theme_color: '#07080d',
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon-180.png', sizes: '180x180', type: 'image/png', purpose: 'any' }] });
  if (req.method === 'GET' && ICONS[u]) {
    const f = path.join(__dirname, 'icons', ICONS[u]);
    if (!fs.existsSync(f)) return json(res, 404, { error: 'no icon' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); return res.end(fs.readFileSync(f));
  }
  if (u.startsWith('/remote/')) return remote(req, res, u);
  if (u.startsWith('/tv/')) return tvRoutes(req, res, u);
  if (req.method === 'GET' && u === '/events') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }, CORS));
    res.write('retry: 4000\n: hello\n\n');
    clients.add(res);
    tvShow.onClient(res);   // a pending "Show on TV" reaches a launcher that is just starting / resuming
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (req.method === 'GET' && u === '/status') return json(res, 200, { ok: true, mock: MOCK, brain: LLM.enabled() ? LLM.describe() : 'built-in parser', tvs: clients.size, budget: LLM.budgetStatus(), tmdb: T.hasTmdb(), omdb: T.hasOmdb(), stt: STT.status(), youtubeSearch: !!E.YT_API_KEY, wol: !!tv.mac });
  if (req.method === 'GET' && u === '/stats') return json(res, 200, Object.assign(M.aggregate(M.read()), { stt: STT.stats() }));
  if (req.method === 'GET' && u === '/last') return json(res, 200, lastEvents);
  if (req.method === 'POST' && u === '/listening') { const b = await body(req); send({ type: b.stop ? 'idle' : 'listening', message: b.why ? String(b.why).slice(0, 160) : undefined }); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && u === '/transcript') { const b = await body(req); send({ type: 'transcript', text: String(b.text || '').slice(0, 400), final: false }); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && u === '/chat/reset') { const b = await body(req); LLM.reset(String(b.client || 'default').slice(0, 64)); if (E.LOG !== '0') console.log('[' + new Date().toLocaleTimeString() + '] new chat'); return json(res, 200, { ok: true }); }
  // ---- chats (v6): list / create / read / rename / delete; stored in data/chats/ ----
  if (u === '/chats' || u.startsWith('/chats/')) return chats(req, res, u);
  if (req.method === 'GET' && u === '/stt') return json(res, 200, STT.status());
  if (req.method === 'POST' && u === '/stt') return stt(req, res);
  if (req.method === 'POST' && u === '/ask') {
    const b = await body(req), text = String(b.text || '').trim().slice(0, 400);
    if (!text) return json(res, 400, { error: 'empty' });
    const id = seq + 1, client = String(b.client || 'default').slice(0, 64);
    // v6: the phone sends chatId; an unknown/missing one starts a new chat. Old phones (no chatId) keep one chat per client.
    const chat = b.chatId ? CH.open(String(b.chatId), { client }) : b.newChat ? CH.create({ client }) : LLM.history(client);
    let got = await new Promise(r => {
      const t = setTimeout(() => r({ type: 'error', message: 'timeout' }), 90000);
      waiters.push(ev => { if (ev.session === id && (ev.type === 'answer' || ev.type === 'error')) { clearTimeout(t); r(ev); return true; } });
      ask(text, { typed: !!b.typed, sttMs: +b.sttMs || 0, client: String(b.client || 'default').slice(0, 64), lang: LANGS.has(b.lang) ? b.lang : 'en-US', chat });
    });
    if (!got.chatId) { got = Object.assign({}, got, { chatId: chat.id, chatTitle: chat.title }); }
    return json(res, 200, got);
  }
  json(res, 404, { error: 'not found' });
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => {
  const ips = [].concat.apply([], Object.values(os.networkInterfaces())).filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('Voice relay on :' + PORT + (MOCK ? ' (MOCK replay)' : '') + ' \u00b7 brain: ' + (LLM.endpoints().map(e => e.model + (e.local ? ' (if Ollama is running)' : '')).concat('built-in parser').join(' \u2192 ')));
  console.log('TV remote \u2192 ' + tv.host + (tv.token ? ' (paired)' : ' (not paired yet: tap Pair on the phone, then Allow on the TV)') + (tv.mac ? ' \u00b7 Wake-on-LAN ' + tv.mac : ''));
  console.log('TV power watch ' + (E.TV_POLL === '0' ? 'off' : 'every ' + tvPower.pollMs / 1000 + ' s') + ' \u00b7 auto-open ' + tvPower.appId + ' on power-on: ' + (tvPower.autoLaunch && E.TV_POLL !== '0' ? 'on' : 'off'));
  if (E.TV_POLL !== '0') tvPower.start();                 // connects the paired remote when the TV is on
  else if (tv.token && E.TV_AUTOCONNECT !== '0') { tv.lastUse = Date.now(); tv.connect(); }
  console.log('TMDB ' + (T.hasTmdb() ? 'ok' : 'MISSING') + ' \u00b7 OMDb ' + (T.hasOmdb() ? 'ok' : 'MISSING') + ' \u00b7 speech-to-text: ' + STT.engine() + ' \u00b7 YouTube: ' + ((E.YT_MODE || 'dial') !== 'search' ? 'DIAL (ids: ' + (E.YT_API_KEY ? 'YouTube API + Wikidata' : 'Wikidata') + ')' : 'remote search + top result'));
  ips.forEach(ip => console.log('  phone: http://' + ip + ':' + PORT + '/'));
});
// Optional https listener so iPhone Safari allows the mic (needs a secure page).
const CERT_DIR = path.join(__dirname, 'certs'), HTTPS_PORT = +(E.HTTPS_PORT || 8788);
if (require.main === module && fs.existsSync(path.join(CERT_DIR, 'server.key')) && fs.existsSync(path.join(CERT_DIR, 'server.crt'))) {
  require('https').createServer({ key: fs.readFileSync(path.join(CERT_DIR, 'server.key')), cert: fs.readFileSync(path.join(CERT_DIR, 'server.crt')) }, (req, res) => server.emit('request', req, res))
    .listen(HTTPS_PORT, '0.0.0.0', () => console.log('  secure phone page: https://<mac-ip>:' + HTTPS_PORT + '/'));
}
module.exports = { server, ask, tv, tvPower, spoken, wakeTv, tvShow };
