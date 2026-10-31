'use strict';
// v6 "Play X on Y". Only official / documented mechanisms, and every answer says what really happened.
//   YouTube  : default YT_MODE=dial: video id (YouTube Data API / Wikidata) -> DIAL, which on tested TVs only OPENS the
//              YouTube app (it can't start a specific video from outside; cast from the YouTube phone app for that).
//              Experimental, off by default (YT_MODE=search): drive the YouTube app with blind remote key presses: open
//              it, open Search, type "song artist", run it, play the first result (yt-search.js). Unreliable.
//              Real-device finding: DIAL POST /ws/apps/YouTube answers 403, and ed.apps.launch deep links only open
//              YouTube idle. YT_MODE=dial is the video id path (video id from the YouTube Data API / Wikidata P1651, then
//              DIAL "v=<id>" with an Origin: https://www.youtube.com header, which some TVs require).
//              Wikidata is optional here: only used to pick a fresh song for "some other song by X".
//   Netflix  : TMDB title -> Wikidata "Netflix ID" (P1874) -> DIAL Netflix "m=https://www.netflix.com/watch/<id>&source_type=4".
//              v6.1: a cold Netflix lands on "Who's watching?", so when Netflix wasn't running before (REST + DIAL GET),
//              wait NETFLIX_PROFILE_WAIT_MS, KEY_ENTER (highlighted profile), wait NETFLIX_REDIAL_WAIT_MS, DIAL again.
//              Fallback: ed.apps.launch DEEP_LINK with the same link (verified only as "Netflix is running").
//   Others   : Prime Video, Disney+, Hulu, HBO Max, Apple TV, Peacock take no title links from outside on Samsung
//              TVs that we can rely on, so the app opens and the answer says to pick the title there.
//   "some streaming service": TMDB watch providers (US flatrate) choose the service; Netflix first (it can play the title).
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), dgram = require('dgram'), { URL } = require('url');
const { PLATFORMS } = require('./catalog');
const YT = require('./yt-search');
const E = process.env;
const DOCK = (() => { try { return require('./dock-apps.json').apps || []; } catch (e) { return []; } })();
const UA = 'GlassHome-relay/6 (personal home TV launcher)';
const dataDir = () => E.DATA_DIR || path.join(__dirname, 'data');

// per-service facts (Tizen store ids for ed.apps.launch; dock ids for REST launch come from dock-apps.json)
const SERVICES = {
  youtube: { name: 'YouTube', dial: 'YouTube', store: '111299001912', support: 'plays' },
  netflix: { name: 'Netflix', dial: 'Netflix', store: '3201907018807', support: 'plays', wd: 'P1874' },
  prime: { name: 'Prime Video', store: '3201910019365', support: 'app' },
  disney: { name: 'Disney+', store: '3201901017640', support: 'app' },
  hulu: { name: 'Hulu', store: '3201601007625', support: 'app' },
  hbomax: { name: 'HBO Max', store: '3202301029760', support: 'app' },
  appletv: { name: 'Apple TV', store: '3201807016597', support: 'app' },
  peacock: { name: 'Peacock', support: 'app' }
};
const ANY_ORDER = ['netflix', 'hbomax', 'prime', 'disney', 'hulu', 'appletv', 'peacock'];
const dockId = k => { const a = DOCK.find(x => x.key === k); return a && a.appId; };

let S = { tv: null, power: null, log: () => {} };
function configure(o) { S = Object.assign({ log: () => {} }, o || {}); }

// ---------- small HTTP helpers ----------
function request(url, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https, body = o.body == null ? null : Buffer.from(String(o.body));
    const headers = Object.assign({ 'User-Agent': UA, Accept: o.accept || 'application/json' }, o.headers || {});
    if (body) headers['Content-Length'] = body.length;
    const req = lib.request(u, { method: o.method || (body ? 'POST' : 'GET'), headers }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => { b += c; if (b.length > 2e6) req.destroy(new Error('too big')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.setTimeout(o.timeout || 8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
async function getJSON(url, o) {
  const r = await request(url, o);
  if (r.status >= 400) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  try { return JSON.parse(r.body); } catch (e) { throw new Error('bad JSON'); }
}

// ---------- remembered plays ("some other song") ----------
function playedFile() { return path.join(dataDir(), 'played.json'); }
function played() { try { return JSON.parse(fs.readFileSync(playedFile(), 'utf8')); } catch (e) { return {}; } }
function remember(service, id, title, more) {
  const p = played(); p[service] = [Object.assign({ id, title, at: Date.now() }, more || {})].concat((p[service] || []).filter(x => x.id !== id)).slice(0, 60);
  try { fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(playedFile(), JSON.stringify(p), { mode: 0o600 }); } catch (e) {}
}
const recentIds = service => (played()[service] || []).map(x => x.id);
const lastPlayed = service => (played()[service] || [])[0] || null;

// ---------- query clean-up ----------
function cleanQuery(q) {
  return String(q || '').replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:please\s+)?(?:play|put on|start|stream|watch)\s+/i, '')
    .replace(/\s+(?:on|in|from|via)\s+(?:youtube|netflix|hulu|prime(?: video)?|amazon(?: prime)?|disney\+?|disney plus|hbo(?: max)?|max|apple tv\+?|peacock|(?:some|a|any)\s+streaming\s+(?:service|app)s?)\s*$/i, '')
    .replace(/^(?:me\s+)?(?:some(?:thing)?|another|any)\s+(?:other\s+|different\s+|new\s+|random\s+)?/i, '')
    .replace(/^(?:me\s+)?(?:a|an|the)\s+(?:(?:other|different|new|random)\s+|(?=(?:songs?|tracks?|music|videos?)\b))/i, '')   // keep "The Office" 
    .replace(/^(?:other|different|random)\s+/i, '')
    .replace(/\b(?:songs?|tracks?|music(?: video)?s?|videos?)\b(?:\s+(?:by|from))?/ig, ' ')
    .replace(/^\s*(?:by|from)\s+/i, '').replace(/\s+/g, ' ').replace(/[?.!,]+$/, '').trim();
}
function serviceKey(s) {
  s = String(s || '').toLowerCase().replace(/[^a-z+ ]/g, '').trim();
  if (!s || /^(any|some|streaming|anything|whatever|best)/.test(s) || /streaming/.test(s)) return 'any';
  if (SERVICES[s]) return s;
  for (const k of Object.keys(PLATFORMS)) if (PLATFORMS[k].words.some(w => s === w || s.indexOf(w) >= 0)) return k;
  return 'any';
}

// ---------- YouTube video lookup ----------
function ytQuotaFile() { return path.join(dataDir(), 'yt-quota.json'); }
function ytQuotaOk() {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); let q = {};
  try { q = JSON.parse(fs.readFileSync(ytQuotaFile(), 'utf8')); } catch (e) {}
  if (q.day !== day) q = { day, searches: 0 };
  if (q.searches >= +(E.YT_DAILY_SEARCHES || 50)) return false;   // 50 x 100 units = half the free 10k/day
  q.searches++; try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(ytQuotaFile(), JSON.stringify(q), { mode: 0o600 }); } catch (e) {}
  return true;
}
async function ytSearch(q, music) {
  const base = E.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
  const url = base + '/search?part=snippet&type=video&maxResults=10' + (music ? '&videoCategoryId=10' : '') + '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(E.YT_API_KEY);
  const j = await getJSON(url);
  return (j.items || []).filter(i => i.id && i.id.videoId).map(i => ({ id: i.id.videoId, title: decodeEntities((i.snippet && i.snippet.title) || q), source: 'YouTube search' }));
}
const decodeEntities = s => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const WD_API = () => E.WIKIDATA_API || 'https://www.wikidata.org/w/api.php';
const WD_SPARQL = () => E.WIKIDATA_SPARQL || 'https://query.wikidata.org/sparql';
async function wdSearch(q, n) {
  const j = await getJSON(WD_API() + '?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=' + (n || 6) + '&search=' + encodeURIComponent(q));
  return (j.search || []).map(x => x.id).filter(id => /^Q\d+$/.test(id));
}
async function wdEntities(ids) {
  if (!ids.length) return {};
  const j = await getJSON(WD_API() + '?action=wbgetentities&format=json&props=claims%7Clabels&languages=en&ids=' + ids.join('%7C'));
  return j.entities || {};
}
const claimVals = (ent, p) => ((ent && ent.claims && ent.claims[p]) || []).filter(c => c.rank !== 'deprecated' && c.mainsnak && c.mainsnak.datavalue)
  .map(c => { const v = c.mainsnak.datavalue.value; return typeof v === 'string' ? v : v && v.id; }).filter(Boolean);
const label = ent => (ent && ent.labels && ent.labels.en && ent.labels.en.value) || '';
// humans, bands, musical groups/duos/ensembles, music projects
const PERFORMER = new Set(['Q5', 'Q215380', 'Q2088357', 'Q9212979', 'Q5741069', 'Q281643', 'Q56816954', 'Q105756498', 'Q216337', 'Q641066']);
async function wdPerformerVideos(qid) {
  const q = 'SELECT ?s ?sLabel ?v WHERE { ?s wdt:P175 wd:' + qid + '; wdt:P1651 ?v. SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 200';
  const j = await getJSON(WD_SPARQL() + '?format=json&query=' + encodeURIComponent(q), { accept: 'application/sparql-results+json', timeout: 12000 });
  const seen = {};
  return ((j.results && j.results.bindings) || []).map(b => ({ id: b.v && b.v.value, title: b.sLabel && b.sLabel.value })).filter(x => x.id && /^[\w-]{11}$/.test(x.id) && !seen[x.id] && (seen[x.id] = 1));
}
// -> { list:[{id,title}], artist, source } or null
async function wikidataVideos(q) {
  const ids = await wdSearch(q, 6); if (!ids.length) return null;
  const ents = await wdEntities(ids);
  for (const id of ids) {
    const ent = ents[id]; if (!ent) continue;
    const vids = claimVals(ent, 'P1651').filter(v => /^[\w-]{11}$/.test(v));
    const types = claimVals(ent, 'P31');
    if (types.some(t => PERFORMER.has(t)) || claimVals(ent, 'P2397').length) {
      const list = await wdPerformerVideos(id).catch(() => []);
      if (list.length) return { list, artist: label(ent), source: 'Wikidata' };
    }
    if (vids.length) {
      const perf = claimVals(ent, 'P175')[0];
      return { list: vids.map(v => ({ id: v, title: label(ent) })), single: true, performerId: perf || null, source: 'Wikidata' };
    }
  }
  return null;
}
function choose(list, o) {
  const recent = recentIds('youtube'), fresh = list.filter(x => recent.indexOf(x.id) < 0);
  const pool = fresh.length ? fresh : list;
  if (o.random) return pool[Math.floor((o.rand || Math.random)() * pool.length)];
  return pool[0];
}
async function findVideo(query, a) {
  const music = a.kind !== 'video', different = !!a.different, errors = [];
  if (E.YT_API_KEY) {
    if (ytQuotaOk()) {
      try { const list = await ytSearch(query, music && a.kind === 'music'); if (list.length) return Object.assign(choose(different ? list : list.slice(0, 1), { random: different }), { source: 'YouTube search' }); }
      catch (e) { errors.push('YouTube API ' + e.message); }
    } else errors.push('YouTube API daily cap');
  }
  try {
    let wd = await wikidataVideos(query);
    if (!wd) { const m = /^(.+?)\s+by\s+(.+)$/i.exec(query); if (m) wd = (await wikidataVideos(m[1])) || (await wikidataVideos(m[2])); }
    if (wd) {
      // "some other song by X" where X resolved to a single song: use that song's performer
      if (wd.single && different && wd.performerId) { const more = await wdPerformerVideos(wd.performerId).catch(() => []); if (more.length) wd = { list: more, source: 'Wikidata' }; }
      const pick = choose(wd.list, { random: !wd.single || different });
      return Object.assign({}, pick, { source: wd.source, artist: wd.artist, count: wd.list.length });
    }
  } catch (e) { errors.push('Wikidata ' + e.message); }
  return { error: errors.join('; ') || 'no video id found' };
}

// ---------- DIAL ----------
let dialCache = null;
function dialBase() { return E.TV_DIAL_BASE || dialCache || ('http://' + S.tv.host + ':' + (E.TV_DIAL_PORT || 8080) + '/ws/apps'); }
async function dialLaunch(app, payload, extra) {
  const headers = Object.assign({ 'Content-Type': 'text/plain; charset="utf-8"' }, (extra && extra.headers) || {});
  const tryOnce = base => request(base.replace(/\/$/, '') + '/' + app, { method: 'POST', body: payload, headers, accept: '*/*', timeout: +(E.DIAL_TIMEOUT_MS || 6000) });
  let r;
  try { r = await tryOnce(dialBase()); }
  catch (e) {
    if (E.TV_DIAL_BASE || E.TV_DIAL_DISCOVER === '0') return { ok: false, error: e.message };
    const found = await discoverDial().catch(() => null);
    if (!found || found === dialBase()) return { ok: false, error: e.message };
    dialCache = found;
    try { r = await tryOnce(found); } catch (x) { return { ok: false, error: x.message }; }
  }
  return { ok: r.status === 201 || r.status === 200, status: r.status, location: r.headers.location || null };
}
// DIAL GET -> 'running' | 'stopped' | 'hidden' | null (unknown)
async function dialState(app) {
  try { const r = await request(dialBase().replace(/\/$/, '') + '/' + app, { accept: '*/*', timeout: 3000 }); if (r.status !== 200) return null; const m = /<state>\s*([a-z]+)\s*<\/state>/i.exec(r.body); return m ? m[1].toLowerCase() : null; }
  catch (e) { return null; }
}
// SSDP unicast M-SEARCH to the TV -> device description LOCATION -> its Application-URL header
function discoverDial() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4'), port = +(E.TV_SSDP_PORT || 1900);
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n');
    const t = setTimeout(() => { try { sock.close(); } catch (e) {} reject(new Error('no SSDP answer')); }, 2500);
    sock.on('message', async b => {
      const m = /^location:\s*(\S+)/im.exec(b.toString()); if (!m) return;
      clearTimeout(t); try { sock.close(); } catch (e) {}
      try { const r = await request(m[1], { accept: '*/*', timeout: 3000 }); const au = r.headers['application-url']; au ? resolve(au.replace(/\/$/, '')) : reject(new Error('no Application-URL')); }
      catch (e) { reject(e); }
    });
    sock.on('error', e => { clearTimeout(t); reject(e); });
    sock.send(msg, port, S.tv.host);
  });
}

// ---------- TV helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function running(key) {
  const id = dockId(key); if (!id) return null;
  try { const st = await S.tv.appStatus(id); return st && (st.running === true || String(st.running) === 'true'); } catch (e) { return null; }
}
async function openApp(key) {
  const id = dockId(key); if (!id) throw new Error('no app id for ' + key);
  return S.tv.launch(id, { noPair: true });
}
async function ensureOn(ctx) {
  const pw = S.power;
  if (!pw || pw.power === 'on' || pw.power === 'unknown') return { ok: true };
  if (!S.tv.mac) return { ok: false, status: 'tv_off', note: 'The TV is off and I don\u2019t know its network address yet, so I can\u2019t wake it. Turn it on with its remote once and I\u2019ll learn it.' };
  let on = false;
  await ctx.step('Waking the TV', async () => {
    pw.suppressLaunch(+(E.PLAY_WAKE_WAIT_MS || 25000) + 30000);
    await (S.wake ? S.wake() : S.tv.wake({ repeats: 3 })); pw.burst(45000);
    on = await pw.waitOn(+(E.PLAY_WAKE_WAIT_MS || 25000));
    return on ? 'TV is on' : 'no answer';
  });
  if (!on) return { ok: false, status: 'tv_off', note: 'I sent the wake signal but the TV didn\u2019t turn on. On the TV, turn on Settings \u203a General \u203a Network \u203a Expert Settings \u203a Power On with Mobile.' };
  await sleep(+(E.PLAY_SETTLE_MS || 5000));   // let the TV finish booting its app framework
  return { ok: true, woke: true };
}

// ---------- YouTube ----------
let ytJob = null;   // the remote-driven search in progress (a newer request cancels it)
async function playYouTube(query, a, ctx) {
  if ((E.YT_MODE || 'dial').toLowerCase() !== 'search') return playYouTubeDial(query, a, ctx);
  let typeQ = query.replace(/\s+by\s+/i, ' '), shown = query, pick = null;
  // optional: "some other song by X" -> a song of X not played lately (YouTube Data API if keyed, else Wikidata)
  if (a.different && E.YT_WIKIDATA !== '0') {
    await ctx.step('Picking another song', async () => {
      pick = await findVideo(query, a).catch(e => ({ error: e.message }));
      if (!pick.id) return 'none (' + pick.error + '), searching \u201c' + query + '\u201d';
      shown = pick.title + (pick.artist && pick.title.indexOf(pick.artist) < 0 ? ' by ' + pick.artist : '');
      typeQ = pick.title + (pick.artist && pick.title.indexOf(pick.artist) < 0 ? ' ' + pick.artist : '');
      return '\u201c' + shown + '\u201d \u00b7 ' + pick.source;
    });
  }
  const remoteOk = !!S.tv.token && await S.tv.ready().then(() => true, () => false);
  if (!remoteOk) {
    await ctx.step('Opening YouTube', async () => { await openApp('youtube'); return 'app only (remote not paired)'; }).catch(() => {});
    return { ok: true, service: 'youtube', status: 'opened_app', query, via: 'rest',
      note: 'I opened YouTube, but the TV remote isn\u2019t paired with the relay, so I can\u2019t search for \u201c' + shown + '\u201d. Pair it from Remote on the phone (accept the prompt on the TV), then ask again.' };
  }
  if (ytJob) ytJob.cancel.stop = true;
  const job = { cancel: { stop: false }, lines: [] }; ytJob = job;
  const go = YT.run(S.tv, typeQ, { appId: dockId('youtube'), cancel: job.cancel, log: l => job.lines.push(l), launch: () => openApp('youtube') })
    .then(r => { if (ytJob === job) ytJob = null; S.log && S.log({ ev: 'yt-search', ok: r.ok, method: r.method, keys: r.keys, ime: r.ime.length, error: r.error }); return r; });
  let r = null;
  await ctx.step('Searching YouTube', async () => {
    if (E.YT_WAIT_DONE === '1') { r = await go; return r.ok ? 'typed \u201c' + r.typed + '\u201d via ' + r.method + ' \u00b7 ' + r.keys + ' keys' : 'stopped: ' + r.error; }
    return 'remote: open search, type \u201c' + typeQ + '\u201d, play the first result';
  });
  remember('youtube', (pick && pick.id) || 'search:' + typeQ.toLowerCase(), (pick && pick.title) || query, { artist: (pick && pick.artist) || undefined, q: query });
  if (r && !r.ok) return { ok: false, service: 'youtube', status: 'error', query, via: 'search', note: 'I opened YouTube but the remote steps stopped (' + r.error + '), so search for \u201c' + shown + '\u201d there.' };
  ctx.emit({ type: 'action', action: 'played', app: 'youtube', title: shown });
  return { ok: true, service: 'youtube', status: 'searching', via: 'search', query: typeQ, title: shown, unverified: true,
    typed: r ? r.typed : undefined, url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(typeQ) };
}
// YT_MODE=dial: the v6 path (video id + DIAL), with the Origin header the YouTube DIAL server checks
async function playYouTubeDial(query, a, ctx) {
  let pick = null;
  await ctx.step('Finding on YouTube', async () => {
    pick = await findVideo(query, a);
    return pick.id ? '\u201c' + pick.title + '\u201d \u00b7 ' + pick.source + (pick.count > 1 ? ' (' + pick.count + ' videos)' : '') : 'no exact video (' + pick.error + ')';
  });
  if (!pick.id) {
    await ctx.step('Opening YouTube', async () => { await openApp('youtube'); return 'app only'; }).catch(() => {});
    return { ok: true, service: 'youtube', status: 'opened_app', query, note: 'I couldn\u2019t find a specific video for \u201c' + query + '\u201d, so I opened YouTube; search for it there.' };
  }
  let res = null;
  await ctx.step('Playing on the TV', async () => {
    const d = await dialLaunch('YouTube', 'v=' + pick.id, E.YT_DIAL_ORIGIN === '' ? null : { headers: { Origin: E.YT_DIAL_ORIGIN || 'https://www.youtube.com' } });
    if (d.ok) {
      res = { status: 'playing', via: 'dial' };
      if (E.YT_DIAL_CONFIRM === '1' && S.tv.paired !== false) setTimeout(() => S.tv.key('KEY_ENTER').catch(() => {}), +(E.YT_DIAL_CONFIRM_MS || 3500));
      return 'DIAL \u00b7 YouTube ' + d.status;
    }
    try { await S.tv.deepLink(SERVICES.youtube.store, 'v=' + pick.id); res = { status: 'opened_app', via: 'deeplink', unverified: true }; return 'DIAL failed (' + (d.error || d.status) + ') \u00b7 deep link sent'; }
    catch (e) { await openApp('youtube'); res = { status: 'opened_app', via: 'rest' }; return 'DIAL failed (' + (d.error || d.status) + ') \u00b7 app only'; }
  });
  remember('youtube', pick.id, pick.title, { artist: pick.artist || undefined, q: query });
  ctx.emit({ type: 'action', action: 'played', app: 'youtube', title: pick.title });
  return Object.assign({ ok: true, service: 'youtube', title: pick.title, videoId: pick.id, url: 'https://www.youtube.com/watch?v=' + pick.id, found_by: pick.source, artist: pick.artist || undefined }, res,
    res.status === 'playing' ? {} : { note: res.unverified ? 'Sent the video link to the YouTube app; if YouTube only opened its home screen, the TV ignored the link.' : 'The TV refused the video link, so I only opened YouTube.' });
}

// ---------- shows & movies ----------
function tmdbGet(p, q) {
  const key = E.TMDB_API_KEY || '', tok = E.TMDB_READ_TOKEN || (/^eyJ/.test(key) ? key : '');
  let url = (E.TMDB_BASE || 'https://api.themoviedb.org/3') + p + (p.indexOf('?') < 0 ? '?' : '&') + (q || '');
  if (!tok) url += '&api_key=' + encodeURIComponent(key);
  return getJSON(url, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
}
async function findTitle(query) {
  const r = await tmdbGet('/search/multi', 'language=en-US&include_adult=false&query=' + encodeURIComponent(query));
  const hit = (r.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv')[0];
  if (!hit) return null;
  const d = await tmdbGet('/' + hit.media_type + '/' + hit.id, 'language=en-US&append_to_response=watch/providers,external_ids');
  const us = ((d['watch/providers'] || {}).results || {}).US || {}, prov = [];
  (us.flatrate || []).concat(us.ads || [], us.free || []).forEach(p => { Object.keys(PLATFORMS).forEach(k => { if (PLATFORMS[k].providers.indexOf(p.provider_id) >= 0 && prov.indexOf(k) < 0) prov.push(k); }); });
  return { title: d.title || d.name || hit.title || hit.name, kind: hit.media_type, year: String(d.release_date || d.first_air_date || '').slice(0, 4) || null, tmdbId: hit.id,
    wikidata: (d.external_ids || {}).wikidata_id || null, providers: prov };
}
async function netflixId(t) {
  if (!t.wikidata || !/^Q\d+$/.test(t.wikidata)) return null;
  const ents = await wdEntities([t.wikidata]);
  return claimVals(ents[t.wikidata], 'P1874').filter(v => /^\d{5,10}$/.test(v))[0] || null;
}
const num = (k, d) => { const v = E[k]; return v === undefined || v === '' || isNaN(+v) ? d : +v; };
// Was Netflix already up (past its profile picker)? REST app status first, DIAL GET as a second opinion.
async function netflixRunning() {
  let rest = null; const id = dockId('netflix');
  if (id) { try { const st = await S.tv.appStatus(id); rest = st && (st.running === true || String(st.running) === 'true' || st.visible === true); } catch (e) {} }
  if (rest) return { running: true, by: 'REST' };
  const ds = await dialState('Netflix');
  if (ds === 'running') return { running: true, by: 'DIAL' };
  return { running: false, by: rest === false ? 'REST' + (ds ? ' + DIAL ' + ds : '') : ds ? 'DIAL ' + ds : 'unknown' };
}
async function playTitle(query, svc, a, ctx) {
  if (!(E.TMDB_API_KEY || E.TMDB_READ_TOKEN)) {
    if (svc === 'any') return { ok: false, status: 'error', note: 'I need the TMDB key on the relay to find where a title streams.' };
    await openApp(svc).catch(() => {});
    return { ok: true, service: svc, status: 'opened_app', query, note: 'I opened ' + SERVICES[svc].name + '; search for \u201c' + query + '\u201d there.' };
  }
  let t = null;
  await ctx.step('Looking up \u201c' + query + '\u201d', async () => {
    t = await findTitle(query);
    return t ? t.title + (t.year ? ' (' + t.year + ')' : '') + ' \u00b7 streams on ' + (t.providers.map(k => PLATFORMS[k].name).join(', ') || 'none of your services') : 'not found';
  });
  if (!t) return { ok: false, status: 'not_found', query, note: 'I couldn\u2019t find \u201c' + query + '\u201d.' };
  const names = t.providers.map(k => PLATFORMS[k].name);
  if (svc === 'any') {
    svc = ANY_ORDER.find(k => t.providers.indexOf(k) >= 0);
    if (!svc) return { ok: false, status: 'not_streaming', title: t.title, note: t.title + ' isn\u2019t on any of your streaming services in the US right now (per TMDB).' };
  } else if (t.providers.length && t.providers.indexOf(svc) < 0) {
    return { ok: false, status: 'not_on_service', service: svc, title: t.title, available_on: names,
      note: 'TMDB says ' + t.title + ' isn\u2019t on ' + SERVICES[svc].name + ' in the US right now' + (names.length ? '; it\u2019s on ' + names.join(', ') + '.' : '.') };
  }
  const name = SERVICES[svc].name;
  if (svc === 'netflix') {
    let nid = null;
    await ctx.step('Finding the Netflix title', async () => { nid = await netflixId(t).catch(() => null); return nid ? 'Netflix id ' + nid + ' (Wikidata)' : 'no Netflix id'; });
    if (nid) {
      const link = 'https://www.netflix.com/' + (E.NETFLIX_LINK === 'title' ? 'title/' : 'watch/') + nid;
      let res = null;
      let before = null;
      await ctx.step('Checking Netflix', async () => { before = await netflixRunning(); return before.running ? 'already running (' + before.by + ')' : 'not running (' + before.by + ')'; });
      await ctx.step('Playing on the TV', async () => {
        const d = await dialLaunch('Netflix', 'm=' + link + '&source_type=4');
        if (d.ok) {
          res = { status: 'playing', via: 'dial' };
          const mode = (E.NETFLIX_PROFILE_ENTER || '1').toLowerCase();
          if (mode === '0' || (before.running && mode !== 'always')) return 'DIAL \u00b7 Netflix ' + d.status + (before.running ? ' \u00b7 no profile step' : '');
          // cold start: Netflix shows "Who's watching?" -> ENTER on the highlighted profile, then send the link again
          if (!S.tv.token || !(await S.tv.ready().then(() => true, () => false))) { res.profile = 'not_paired'; return 'DIAL \u00b7 Netflix ' + d.status + ' \u00b7 remote not paired, profile step skipped'; }
          await sleep(num('NETFLIX_PROFILE_WAIT_MS', 5000));
          await S.tv.key('KEY_ENTER');
          await sleep(num('NETFLIX_REDIAL_WAIT_MS', 5000));
          const d2 = await dialLaunch('Netflix', 'm=' + link + '&source_type=4');
          res.via = 'dial+profile'; res.redial = d2.status || d2.error;
          if (!d2.ok) res.profile = 'redial_failed';
          return 'DIAL ' + d.status + ' \u00b7 profile ENTER \u00b7 DIAL again ' + (d2.status || d2.error);
        }
        try {
          await S.tv.deepLink(SERVICES.netflix.store, 'm=' + link + '&source_type=4'); await sleep(+(E.PLAY_VERIFY_MS || 3000));
          res = { status: (await running('netflix')) ? 'opened_app' : 'error', via: 'deeplink', unverified: true }; return 'deep link sent';
        } catch (e) { await openApp('netflix'); res = { status: 'opened_app', via: 'rest' }; return 'app only'; }
      });
      ctx.emit({ type: 'action', action: 'played', app: 'netflix', title: t.title });
      return Object.assign({ ok: res.status !== 'error', service: 'netflix', title: t.title, year: t.year, kind: t.kind }, res,
        res.status === 'playing' ? { note: res.profile === 'not_paired' ? 'If Netflix asks who\u2019s watching, pick your profile and ask me again (the TV remote isn\u2019t paired with the relay, so I couldn\u2019t do it).'
          : res.profile === 'redial_failed' ? 'I picked your profile, but Netflix didn\u2019t take the title link the second time; ask again or pick ' + t.title + ' there.'
          : t.kind === 'tv' ? 'Netflix resumes the series where you left off (or starts episode 1).' : undefined }
          : { note: res.via === 'deeplink' ? 'Sent the title link to Netflix; if it only opened Netflix home, search for ' + t.title + '.' : 'Netflix didn\u2019t accept the title link, so I only opened Netflix; search for ' + t.title + '.' });
    }
  }
  await ctx.step('Opening ' + name, async () => { await openApp(svc); return 'app only (no title link for ' + name + ')'; });
  ctx.emit({ type: 'action', action: 'played', app: svc, title: t.title });
  return { ok: true, service: svc, title: t.title, year: t.year, status: 'opened_app',
    note: name + ' doesn\u2019t accept title links from the relay, so I opened the app; pick ' + t.title + ' there.' };
}

// ---------- entry point (LLM tool play_on_tv and the built-in parser) ----------
async function run(a, ctx) {
  a = a || {};
  if (!S.tv) return { ok: false, status: 'error', note: 'TV control isn\u2019t set up on the relay.' };
  let svc = serviceKey(a.service), query = cleanQuery(a.query);
  const kind = a.kind || (svc === 'youtube' ? 'music' : 'title');
  if (!query && a.different && svc === 'youtube') { const lp = lastPlayed('youtube'); if (lp) query = lp.artist || lp.q || lp.title; }
  if (!query) return { ok: false, status: 'error', note: 'What should I play?' };
  if (svc === 'any' && (kind === 'music' || kind === 'video')) svc = 'youtube';
  const on = await ensureOn(ctx); if (!on.ok) { on.say = on.note; if (ctx) ctx.played = { status: on.status }; return on; }
  const out = svc === 'youtube' ? await playYouTube(query, Object.assign({}, a, { kind }), ctx) : await playTitle(query, svc, a, ctx);
  if (on.woke) out.woke_tv = true;
  out.say = say(out);
  if (ctx) ctx.played = { status: out.status, service: out.service, title: out.title, via: out.via, url: out.url };
  return out;
}
function say(r) {
  const svcName = r.service && SERVICES[r.service] ? SERVICES[r.service].name : '';
  if (r.status === 'playing') return (r.service === 'youtube' ? 'Playing \u201c' + r.title + '\u201d on YouTube.' : 'Starting ' + r.title + ' on ' + svcName + '.') + (r.note ? ' ' + r.note : '');
  if (r.status === 'searching') return 'Searching YouTube for ' + r.title + ' and playing the top result.' + (r.note ? ' ' + r.note : '');
  if (r.status === 'opened_app') return r.note || ('Opened ' + svcName + '.');
  return r.note || 'I couldn\u2019t play that.';
}
module.exports = { run, configure, cleanQuery, serviceKey, findVideo, wikidataVideos, dialLaunch, dialState, netflixRunning, discoverDial, findTitle, SERVICES, say, played, remember, _reset: () => { dialCache = null; }, _ytJob: () => ytJob };
