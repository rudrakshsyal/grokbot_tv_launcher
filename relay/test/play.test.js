'use strict';
// "Play X on Y" against fakes only: fake TV (REST + DIAL), fake Wikidata API/SPARQL, fake TMDB, fake YouTube Data API.
// No network, no keys: run with GEMINI_API_KEY/TMDB_API_KEY unset; a fake TMDB key points at the local fake.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const FAKE = require('./fake-tv');
// Never write to the real logs/data when run on its own (run-all.sh sets these too).
{ const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'play-iso-')); for (const k of ['LOG_DIR', 'METRICS_DIR', 'DATA_DIR', 'CHATS_DIR']) if (!process.env[k]) process.env[k] = path.join(iso, k.toLowerCase()); }
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok  ' + m); };
// REST launches use the dock snapshot's ids (dock-apps.json: Samsung store ids since the post-v6.1 TV fix), as the deployed relay does
const SNAPID = k => (require('../dock-apps.json').apps.find(x => x.key === k) || {}).appId;
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- fake knowledge services ----
const WD = {
  Q100: { labels: { en: { value: 'RÜFÜS DU SOL' } }, claims: { P31: [cl('Q215380', true)] } },
  Q200: { labels: { en: { value: 'Innerbloom' } }, claims: { P31: [cl('Q7366', true)], P1651: [cl('IBinnerblm1')], P175: [cl('Q100', true)] } },
  Q300: { labels: { en: { value: 'Breaking Bad' } }, claims: { P1874: [cl('70143836')] } },
  Q400: { labels: { en: { value: 'Dune' } }, claims: {} }
};
function cl(v, ent) { return { rank: 'normal', mainsnak: { datavalue: { value: ent ? { id: v } : v } } }; }
const SEARCH = { 'rüfüs du sol': ['Q100'], 'innerbloom': ['Q200'] };
const SONGS = [['RDSsong0001', 'Innerbloom'], ['RDSsong0002', 'Underwater'], ['RDSsong0003', 'Alive'], ['bad id', 'Broken']];
const TM = {
  'breaking bad': { media_type: 'tv', id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', wd: 'Q300', prov: [8] },
  'dune': { media_type: 'movie', id: 438631, title: 'Dune', release_date: '2021-09-15', wd: 'Q400', prov: [1899, 9] },
  'the office': { media_type: 'tv', id: 2316, name: 'The Office', first_air_date: '2005-03-24', wd: null, prov: [386] },
  'old film': { media_type: 'movie', id: 5, title: 'Old Film', release_date: '1950-01-01', wd: null, prov: [] }
};
const hits = { wd: [], sparql: 0, tmdb: [], yt: 0, tmdbAuth: [] };
const svc = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), q = u.searchParams, send = j => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (u.pathname === '/w/api.php') {
    hits.wd.push(q.get('action'));
    if (q.get('action') === 'wbsearchentities') return send({ search: (SEARCH[q.get('search').toLowerCase()] || []).map(id => ({ id })) });
    const ents = {}; q.get('ids').split('|').forEach(id => { if (WD[id]) ents[id] = WD[id]; }); return send({ entities: ents });
  }
  if (u.pathname === '/sparql') {
    hits.sparql++; const m = /wd:(Q\d+)/.exec(q.get('query'));
    return send({ results: { bindings: m && m[1] === 'Q100' ? SONGS.map(s => ({ s: { value: 'x' }, sLabel: { value: s[1] }, v: { value: s[0] } })) : [] } });
  }
  if (u.pathname === '/yt/search') { hits.yt++; return send({ items: [{ id: { videoId: 'YTapi000001' }, snippet: { title: 'Official &amp; Live' } }] }); }
  if (u.pathname.indexOf('/tmdb/') === 0) {
    hits.tmdb.push(u.pathname); hits.tmdbAuth.push(q.get('api_key') ? 'key' : (req.headers.authorization ? 'bearer' : 'none'));
    if (u.pathname === '/tmdb/search/multi') { const t = TM[q.get('query').toLowerCase()]; return send({ results: t ? [Object.assign({}, t)] : [] }); }
    const m = /^\/tmdb\/(tv|movie)\/(\d+)$/.exec(u.pathname), t = m && Object.values(TM).find(x => String(x.id) === m[2]);
    if (!t) { res.writeHead(404); return res.end('{}'); }
    return send(Object.assign({}, t, { 'watch/providers': { results: { US: { flatrate: t.prov.map(p => ({ provider_id: p })) } } }, external_ids: { wikidata_id: t.wd } }));
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(r => svc.listen(0, '127.0.0.1', r));
  const TV = await FAKE.start(), base = 'http://127.0.0.1:' + svc.address().port;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
  Object.assign(process.env, { DATA_DIR: data, CHATS_DIR: path.join(data, 'chats'), LOG: '0', WIKIDATA_API: base + '/w/api.php', WIKIDATA_SPARQL: base + '/sparql',
    TMDB_BASE: base + '/tmdb', TMDB_API_KEY: 'fake-test-key', TV_DIAL_BASE: 'http://127.0.0.1:' + TV.dialPort + '/ws/apps', PLAY_SETTLE_MS: '0', PLAY_VERIFY_MS: '50', PLAY_WAKE_WAIT_MS: '1500',
    YT_API_KEY: '', GEMINI_API_KEY: '', YT_MODE: 'dial', TV_IP: '127.0.0.1', TV_REST_PORT: String(TV.restPort), TV_WS_PORT: '1', TV_TOKEN_FILE: path.join(data, 'none.json'), TV_MAC: '' });
  const PLAY = require('../play'), { TvRemote } = require('../tv-remote');
  const tv = new TvRemote({ host: '127.0.0.1', wsPort: 1, restPort: TV.restPort, tokenFile: path.join(data, 'none.json'), restTimeout: 500 });
  const power = { power: 'on' };
  PLAY.configure({ tv, power });
  const mkctx = () => { const c = { steps: [], events: [] }; c.step = async (l, fn) => { const d = await fn(); c.steps.push(l + ': ' + d); return d; }; c.emit = e => c.events.push(e); return c; };
  const dial = () => TV.dial.calls[TV.dial.calls.length - 1];

  // 1. query clean-up + service keys
  ok(PLAY.cleanQuery('some other RÜFÜS DU SOL song') === 'RÜFÜS DU SOL' && PLAY.cleanQuery('Breaking Bad on Netflix') === 'Breaking Bad' && PLAY.cleanQuery('play “Dune” on some streaming service') === 'Dune', 'cleanQuery strips play/other/song/"on <service>"');
  ok(PLAY.serviceKey('some streaming service') === 'any' && PLAY.serviceKey('Netflix') === 'netflix' && PLAY.serviceKey('max') === 'hbomax' && PLAY.serviceKey('Amazon Prime') === 'prime' && PLAY.serviceKey('') === 'any', 'serviceKey maps names, "some streaming service" -> any');

  // 2. YT_MODE=dial (the v6 path): artist -> Wikidata performer songs -> DIAL v=<id> (+ Origin header) -> 201 -> playing
  let c = mkctx(), r = await PLAY.run({ query: 'some RÜFÜS DU SOL song', service: 'youtube' }, c);
  ok(r.status === 'playing' && r.via === 'dial' && /^RDSsong000[123]$/.test(r.videoId) && dial().app === 'YouTube' && dial().body === 'v=' + r.videoId && /text\/plain/.test(dial().type) && dial().origin === 'https://www.youtube.com', 'artist -> Wikidata songs -> DIAL POST /ws/apps/YouTube "v=' + r.videoId + '" -> 201 -> playing');
  ok(TV.running['9Ur5IzDKqV.TizenYouTube'] && hits.sparql === 1, 'fake TV now runs YouTube; one SPARQL query');
  ok(/^Playing “.+” on YouTube\.$/.test(r.say) && c.events[0].action === 'played' && c.ctx === undefined && c.played.status === 'playing' && /youtube\.com\/watch\?v=/.test(c.played.url), 'say + ctx.played + "played" event (not a relaunch action): ' + r.say);
  ok(c.steps.length === 2 && /Finding on YouTube: “.+” · Wikidata \(3 videos\)/.test(c.steps[0]) && /DIAL · YouTube 201/.test(c.steps[1]), 'steps: ' + c.steps.join(' / '));
  const pj = path.join(data, 'played.json');
  ok(JSON.parse(fs.readFileSync(pj, 'utf8')).youtube[0].id === r.videoId && (fs.statSync(pj).mode & 0o777) === 0o600, 'remembered in data/played.json (mode 600)');
  // 3. "some other song" never repeats until the list is used up
  const seen = [r.videoId];
  for (let i = 0; i < 2; i++) { r = await PLAY.run({ query: 'some other RÜFÜS DU SOL song', service: 'youtube', different: true }, mkctx()); seen.push(r.videoId); }
  ok(new Set(seen).size === 3, '"some other song" x2 -> 3 different videos (' + seen.join(', ') + ')');
  r = await PLAY.run({ service: 'youtube', different: true }, mkctx());
  ok(r.status === 'playing' && /^RDSsong/.test(r.videoId), '"play something different" with no name -> reuses the last title as the query');
  // 4. a song with its own P1651 plays exactly that video
  r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, mkctx());
  ok(r.status === 'playing' && r.videoId === 'IBinnerblm1' && dial().body === 'v=IBinnerblm1', 'song with Wikidata YouTube id -> that exact video');
  r = await PLAY.run({ query: 'another song by Innerbloom', service: 'youtube', different: true }, mkctx());
  ok(r.status === 'playing' && /^RDSsong/.test(r.videoId), '"different" on a single song -> its performer\'s other songs');
  // 5. nothing on Wikidata -> honest app-open
  c = mkctx(); r = await PLAY.run({ query: 'zzz unknown band', service: 'youtube' }, c);
  ok(r.status === 'opened_app' && /couldn’t find a specific video/.test(r.say) && TV.rest.calls.indexOf('POST /api/v2/applications/' + SNAPID('youtube')) >= 0, 'unknown -> opens YouTube and says so');
  // 6. YouTube Data API when YT_API_KEY is set, capped per day
  process.env.YT_API_KEY = 'fake-yt'; process.env.YT_API_BASE = base + '/yt'; process.env.YT_DAILY_SEARCHES = '1';
  r = await PLAY.run({ query: 'anything live', service: 'youtube', kind: 'video' }, mkctx());
  ok(r.status === 'playing' && r.videoId === 'YTapi000001' && r.title === 'Official & Live' && r.found_by === 'YouTube search' && hits.yt === 1, 'YT_API_KEY -> YouTube Data API search (entities decoded)');
  r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, mkctx());
  ok(hits.yt === 1 && r.videoId === 'IBinnerblm1' && JSON.parse(fs.readFileSync(path.join(data, 'yt-quota.json'))).searches === 1, 'daily search cap reached -> falls back to Wikidata (no extra API call)');
  process.env.YT_API_KEY = '';
  // 7. DIAL refused -> no pairing -> REST app open, said honestly
  TV.dial.status = 404; c = mkctx(); r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, c);
  ok(r.status === 'opened_app' && r.via === 'rest' && /refused the video link/.test(r.say) && /DIAL failed \(404\)/.test(c.steps[1]), 'DIAL 404 -> app only, says the TV refused the link');
  TV.dial.status = 201;

  // 8. Netflix: TMDB -> Wikidata P1874 -> DIAL m=<watch link> (profile step off here; tested in 16)
  process.env.NETFLIX_PROFILE_ENTER = '0';
  c = mkctx(); r = await PLAY.run({ query: 'Breaking Bad on Netflix', service: 'netflix' }, c);
  ok(r.status === 'playing' && dial().app === 'Netflix' && dial().body === 'm=https://www.netflix.com/watch/70143836&source_type=4' && TV.running['org.tizen.netflix-app'], 'Netflix: TMDB -> Wikidata P1874 70143836 -> DIAL "m=https://www.netflix.com/watch/70143836&source_type=4"');
  ok(/^Starting Breaking Bad on Netflix\. Netflix resumes/.test(r.say) && c.steps.join('|').indexOf('Breaking Bad (2008) · streams on Netflix') >= 0 && c.steps.join('|').indexOf('Netflix id 70143836 (Wikidata)') >= 0, 'Netflix say + steps');
  ok(hits.tmdbAuth.every(a => a === 'key'), 'TMDB v3 key sent as api_key (fake)');
  process.env.NETFLIX_LINK = 'title'; await PLAY.run({ query: 'Breaking Bad', service: 'netflix' }, mkctx());
  ok(dial().body === 'm=https://www.netflix.com/title/70143836&source_type=4', 'NETFLIX_LINK=title -> /title/<id> link'); delete process.env.NETFLIX_LINK;
  delete process.env.NETFLIX_PROFILE_ENTER;
  // 9. not on the asked service
  const nDial = TV.dial.calls.length, nRest = TV.rest.calls.length;
  r = await PLAY.run({ query: 'Breaking Bad', service: 'hulu' }, mkctx());
  ok(r.status === 'not_on_service' && r.available_on.join() === 'Netflix' && /isn’t on Hulu.*it’s on Netflix/.test(r.say) && TV.dial.calls.length === nDial && TV.rest.calls.filter(x => /^POST/.test(x)).length === TV.rest.calls.slice(0, nRest).filter(x => /^POST/.test(x)).length, 'Breaking Bad on Hulu -> not_on_service, nothing launched');
  // 10. "some streaming service" -> provider order (HBO Max before Prime), apps without links open honestly
  c = mkctx(); r = await PLAY.run({ query: 'Dune', service: 'some streaming service' }, c);
  ok(r.status === 'opened_app' && r.service === 'hbomax' && /HBO Max doesn’t accept title links.*pick Dune there/.test(r.say) && TV.running[SNAPID('hbomax')], 'Dune on some streaming service -> HBO Max app opened, honest note');
  r = await PLAY.run({ query: 'Dune', service: 'prime' }, mkctx());
  ok(r.status === 'opened_app' && r.service === 'prime' && TV.running[SNAPID('prime')], 'Dune on Prime -> Prime Video app opened');
  r = await PLAY.run({ query: 'The Office', service: 'any' }, mkctx());
  ok(r.service === 'peacock' && r.status === 'opened_app', 'The Office (Peacock only) on any service -> Peacock');
  r = await PLAY.run({ query: 'Old Film', service: 'any' }, mkctx());
  ok(r.status === 'not_streaming' && /isn’t on any of your streaming services/.test(r.say), 'no US flatrate provider -> not_streaming');
  r = await PLAY.run({ query: 'Nope Nothing', service: 'netflix' }, mkctx());
  ok(r.status === 'not_found', 'unknown title -> not_found');
  // 15. experimental YouTube search driven by the paired remote (YT_MODE=search, opt-in)
  const tokFile = path.join(data, 'tok.json'); fs.writeFileSync(tokFile, JSON.stringify({ token: TV.token }), { mode: 0o600 });
  const ptv = new TvRemote({ host: '127.0.0.1', wsPort: TV.wsPort, restPort: TV.restPort, tokenFile: tokFile, restTimeout: 500 });
  PLAY.configure({ tv: ptv, power });
  process.env.YT_MODE = 'search';
  Object.assign(process.env, { YT_WAIT_DONE: '1', YT_LAUNCH_WAIT_MS: '0', YT_RESUME_WAIT_MS: '0', YT_PROFILE_WAIT_MS: '0', YT_SEARCH_WAIT_MS: '0', YT_KEY_GAP_MS: '3', YT_KB_GAP_MS: '1',
    YT_IME_WAIT_MS: '250', YT_RESULTS_WAIT_MS: '0', YT_SEARCH_KEYS: 'LEFT,WAIT:20,UP*6,ENTER', NETFLIX_PROFILE_WAIT_MS: '30', NETFLIX_REDIAL_WAIT_MS: '30' });
  const YTS = require('../yt-search'), YTID = SNAPID('youtube');   // the id play.js REST-launches
  const keysOf = from => TV.events.slice(from).filter(e => /^key /.test(e)).map(e => e.slice(4));
  const SEARCH = ['KEY_LEFT', 'KEY_UP', 'KEY_UP', 'KEY_UP', 'KEY_UP', 'KEY_UP', 'KEY_UP', 'KEY_ENTER'];
  // 15a. cold start: launch -> profile ENTER -> side nav search -> YouTube keyboard grid -> first suggestion -> first result
  Object.keys(TV.running).forEach(k => TV.running[k] = false);
  let ev0 = TV.events.length; c = mkctx();
  r = await PLAY.run({ query: 'Underwater by RÜFÜS DU SOL', service: 'youtube' }, c);
  const grid = YTS.gridKeys('underwater rufus du sol', YTS.DEFAULT_KEYBOARD, 'a').keys;
  let ks = keysOf(ev0), want = ['KEY_ENTER'].concat(SEARCH, grid, ['KEY_RIGHT', 'KEY_ENTER', 'KEY_ENTER']);
  ok(r.status === 'searching' && r.via === 'search' && r.typed === 'underwater rufus du sol' && TV.events[ev0] === 'launch ' + YTID, 'cold YouTube: REST launch first, typed "' + r.typed + '" (accents dropped, "by" removed)');
  ok(JSON.stringify(ks) === JSON.stringify(want), 'cold key sequence: profile ENTER, LEFT, UP x6, ENTER, ' + grid.length + ' keyboard keys, RIGHT+ENTER (suggestion), ENTER (top result)');
  ok(r.say === 'Searching YouTube for Underwater by RÜFÜS DU SOL and playing the top result.' && c.played.status === 'searching' && c.events[0].action === 'played', 'honest answer: ' + r.say);
  ok(!TV.events.slice(ev0).some(e => /^text |input-end|^dial YouTube/.test(e)), 'no IME event from the TV -> no SendInputString, no DIAL (grid typing)');
  ok(c.steps.some(x => /^Searching YouTube: typed .* via grid/.test(x)), 'step: ' + c.steps[c.steps.length - 1]);
  // 15b. YouTube already on screen: no launch, no profile ENTER
  ev0 = TV.events.length; r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, mkctx());
  ks = keysOf(ev0);
  ok(r.status === 'searching' && !TV.events.slice(ev0).some(e => /^launch /.test(e)) && JSON.stringify(ks.slice(0, 8)) === JSON.stringify(SEARCH), 'already running: no relaunch, no profile ENTER, starts with LEFT');
  // 15c. TV reports its system keyboard (ms.remote.imeStart) -> SendInputString (base64) + SendInputEnd, no grid walk
  TV.onFrame = (f, send) => { const p = f.params || {}; if (p.DataOfCmd === 'KEY_ENTER' && TV.events.slice(-2)[0] === 'key KEY_UP') send({ event: 'ms.remote.imeStart', data: 'search' }); };
  ev0 = TV.events.length; const fr0 = TV.frames.length; c = mkctx();
  r = await PLAY.run({ query: 'Underwater RÜFÜS DU SOL', service: 'youtube' }, c);
  const sent = TV.frames.slice(fr0).filter(f => f.params && f.params.TypeOfRemote === 'SendInputString')[0];
  ok(r.typed === 'Underwater RÜFÜS DU SOL' && sent && sent.params.DataOfCmd === 'base64' && Buffer.from(sent.params.Cmd, 'base64').toString() === 'Underwater RÜFÜS DU SOL', 'imeStart seen -> SendInputString base64 frame carries the exact UTF-8 text');
  const tail = TV.events.slice(ev0).filter(e => !/^launch/.test(e));
  ok(tail.indexOf('text Underwater RÜFÜS DU SOL') === SEARCH.length && tail[SEARCH.length + 1] === 'input-end' && tail.slice(SEARCH.length + 2).join() === 'key KEY_ENTER', 'IME order: search keys, text, SendInputEnd, ENTER (top result); no keyboard-grid keys');
  ok(TV.frames.slice(fr0).some(f => f.method === 'ms.channel.emit' && f.params.event === 'custom.remote.textReceived') || TV.frames.some(f => f.params && f.params.event === 'custom.remote.textReceived'), 'textReceived notice sent before the first text (samsungtvws behaviour)');
  TV.onFrame = null;
  // 15d. every sequence is configurable
  Object.assign(process.env, { YT_SEARCH_KEYS: 'UP*2,ENTER', YT_SUBMIT_KEYS: 'DOWN*2,ENTER', YT_PLAY_KEYS: 'WAIT:10,DOWN,ENTER', YT_TYPE: 'grid', YT_KEYBOARD: 'abc|def|___', YT_KB_START: 'a' });
  ev0 = TV.events.length; r = await PLAY.run({ query: 'bad', service: 'youtube' }, mkctx());
  ok(keysOf(ev0).join(' ') === 'KEY_UP KEY_UP KEY_ENTER KEY_RIGHT KEY_ENTER KEY_LEFT KEY_ENTER KEY_DOWN KEY_ENTER KEY_DOWN KEY_DOWN KEY_ENTER KEY_DOWN KEY_ENTER', 'YT_SEARCH_KEYS / YT_KEYBOARD / YT_SUBMIT_KEYS / YT_PLAY_KEYS honored: ' + keysOf(ev0).length + ' keys');
  ['YT_SUBMIT_KEYS', 'YT_PLAY_KEYS', 'YT_TYPE', 'YT_KEYBOARD', 'YT_KB_START'].forEach(k => delete process.env[k]); process.env.YT_SEARCH_KEYS = 'LEFT,WAIT:20,UP*6,ENTER';
  ok(YTS.parseSeq('left,UP*3,wait:50,KEY_ENTER').map(x => x.key || 'w' + x.wait).join() === 'KEY_LEFT,KEY_UP,KEY_UP,KEY_UP,w50,KEY_ENTER' && (() => { try { YTS.parseSeq('LEFT,??'); return false; } catch (e) { return true; } })(), 'key sequence syntax: KEY, KEY*n, WAIT:ms; bad tokens rejected');
  // 15e. "some other song" -> optional Wikidata pick of a fresh song, then search "<song> <artist>"
  r = await PLAY.run({ query: 'some other RÜFÜS DU SOL song', service: 'youtube', different: true }, mkctx());
  ok(r.status === 'searching' && /^(Innerbloom|Underwater|Alive|Broken) by RÜFÜS DU SOL$/.test(r.title) && / rufus du sol$/.test(r.typed), '"some other song" -> Wikidata song pick -> searches "' + r.typed + '"');
  // 15f. a newer request cancels a search still in progress
  process.env.YT_WAIT_DONE = '0'; process.env.YT_RESULTS_WAIT_MS = '400';
  await PLAY.run({ query: 'first', service: 'youtube' }, mkctx()); const j1 = PLAY._ytJob();
  await wait(100); await PLAY.run({ query: 'second', service: 'youtube' }, mkctx());
  ok(j1 && j1.cancel.stop === true, 'second request cancels the first remote sequence');
  await wait(1500); process.env.YT_WAIT_DONE = '1'; process.env.YT_RESULTS_WAIT_MS = '0';
  // 15g. remote not paired -> opens YouTube and says why it can't search
  PLAY.configure({ tv, power }); r = await PLAY.run({ query: 'Underwater', service: 'youtube' }, mkctx());
  ok(r.status === 'opened_app' && /isn’t paired/.test(r.say), 'unpaired remote -> opened_app, honest: ' + r.say.slice(0, 60) + '…');
  // 15h. YT_MODE=dial with the Origin header the YouTube DIAL server requires; without it -> 403 -> app fallback
  TV.dial.requireOrigin.YouTube = 'https://www.youtube.com'; process.env.YT_MODE = 'dial';
  r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, mkctx());
  ok(r.status === 'playing' && dial().origin === 'https://www.youtube.com', 'YT_MODE=dial sends Origin: https://www.youtube.com -> accepted');
  process.env.YT_DIAL_ORIGIN = ''; r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, mkctx());
  ok(r.status === 'opened_app' && /403/.test(JSON.stringify(TV.events.slice(-3))), 'YT_DIAL_ORIGIN="" -> 403 like the real TV -> app only');
  delete process.env.YT_DIAL_ORIGIN; TV.dial.requireOrigin = {};

  // 16. Netflix cold start: DIAL -> profile picker -> KEY_ENTER -> DIAL again; skip ENTER when Netflix already ran
  PLAY.configure({ tv: ptv, power });
  Object.keys(TV.running).forEach(k => TV.running[k] = false);
  ev0 = TV.events.length; c = mkctx(); r = await PLAY.run({ query: 'Breaking Bad', service: 'netflix' }, c);
  ok(TV.events.slice(ev0).join() === 'dial Netflix 201,key KEY_ENTER,dial Netflix 200' && r.via === 'dial+profile' && r.redial === 200 && r.status === 'playing', 'Netflix cold: DIAL 201 -> ENTER (profile) -> DIAL again 200: ' + TV.events.slice(ev0).join(' → '));
  ok(TV.dial.calls.some(x => x.method === 'GET' && x.app === 'Netflix') && c.steps.some(x => /^Checking Netflix: not running/.test(x)), 'state checked first (REST app status + DIAL GET)');
  ev0 = TV.events.length; c = mkctx(); r = await PLAY.run({ query: 'Breaking Bad', service: 'netflix' }, c);
  ok(TV.events.slice(ev0).join() === 'dial Netflix 200' && r.via === 'dial' && /already running/.test(c.steps.join()), 'Netflix already running: one DIAL, no ENTER');
  Object.keys(TV.running).forEach(k => TV.running[k] = false); process.env.NETFLIX_PROFILE_ENTER = '0';
  ev0 = TV.events.length; r = await PLAY.run({ query: 'Breaking Bad', service: 'netflix' }, mkctx());
  ok(TV.events.slice(ev0).join() === 'dial Netflix 201', 'NETFLIX_PROFILE_ENTER=0 -> no ENTER, no redial'); delete process.env.NETFLIX_PROFILE_ENTER;
  PLAY.configure({ tv, power }); Object.keys(TV.running).forEach(k => TV.running[k] = false);
  r = await PLAY.run({ query: 'Breaking Bad', service: 'netflix' }, mkctx());
  ok(r.status === 'playing' && /pick your profile/.test(r.say), 'cold Netflix with no paired remote: says to pick the profile');

  // 11. Netflix title without a P1874 id -> app only
  WD.Q300.claims = {}; r = await PLAY.run({ query: 'Breaking Bad', service: 'netflix' }, mkctx());
  ok(r.status === 'opened_app' && /Netflix doesn’t accept title links|pick Breaking Bad/.test(r.say), 'no Netflix id on Wikidata -> opens Netflix, says pick it there');
  // 12. without a TMDB key: named service -> app open; any -> needs key
  process.env.TMDB_API_KEY = '';
  r = await PLAY.run({ query: 'Dune', service: 'disney' }, mkctx()); const r2 = await PLAY.run({ query: 'Dune', service: 'any' }, mkctx());
  ok(r.status === 'opened_app' && /search for “Dune” there/.test(r.say) && r2.status === 'error' && /TMDB key/.test(r2.say), 'no TMDB key: named service opens the app; "any" explains the key is needed');
  process.env.TMDB_API_KEY = 'eyJfake.read.token';
  await PLAY.run({ query: 'Dune', service: 'prime' }, mkctx());
  ok(hits.tmdbAuth[hits.tmdbAuth.length - 1] === 'bearer', 'TMDB v4 read token (eyJ...) sent as Bearer, not in the URL');
  process.env.TMDB_API_KEY = 'fake-test-key';

  // 13. TV off: no MAC -> clear answer; MAC -> wake, wait, play
  process.env.YT_MODE = 'dial';
  power.power = 'off'; tv.mac = null;
  c = mkctx(); r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, c);
  ok(r.status === 'tv_off' && /Turn it on with its remote once/.test(r.say) && c.played.status === 'tv_off', 'TV off, MAC unknown -> tv_off, nothing sent');
  const calls = []; tv.mac = '02:00:5E:10:20:30'; tv.wake = async o => { calls.push('wake x' + o.repeats); setTimeout(() => { power.power = 'on'; }, 100); return { sent: 3 }; };
  power.suppressLaunch = ms => calls.push('suppress'); power.burst = ms => calls.push('burst ' + ms);
  power.waitOn = async ms => { const t = Date.now(); while (Date.now() - t < ms) { if (power.power === 'on') return true; await wait(20); } return false; };
  c = mkctx(); r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, c);
  ok(r.status === 'playing' && r.woke_tv && calls.join() === 'suppress,wake x3,burst 45000' && c.steps[0] === 'Waking the TV: TV is on', 'TV off + MAC -> Wake-on-LAN x3, launcher auto-open suppressed, waits, then plays');
  power.power = 'off'; tv.wake = async () => ({ sent: 3 });
  r = await PLAY.run({ query: 'Innerbloom', service: 'youtube' }, mkctx());
  ok(r.status === 'tv_off' && /Power On with Mobile/.test(r.say), 'wake ignored -> tv_off with the "Power On with Mobile" setting hint');
  power.power = 'on';

  // 14. end to end through the relay with no LLM (built-in parser): /ask "play innerbloom on youtube"
  process.env.LLM = 'off';
  const relay = require('../server');
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  const rb = 'http://127.0.0.1:' + relay.server.address().port;
  const ask = async (text, extra) => (await fetch(rb + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ text, client: 'play-test' }, extra || {})) })).json();
  PLAY.configure({ tv, power });   // the relay configured its own TV object; point back at the fake
  let a = await ask('play innerbloom on youtube', { newChat: true });
  ok(a.played && a.played.status === 'playing' && /Playing “Innerbloom” on YouTube/.test(a.answer || a.text || '') && a.chatId, '/ask "play innerbloom on youtube" (rule parser) -> playing: ' + (a.answer || a.text));
  const chat = await (await fetch(rb + '/chats/' + a.chatId)).json();
  const last = chat.messages[chat.messages.length - 1];
  ok(last.role === 'assistant' && last.played && last.played.status === 'playing', 'the chat keeps the played result');
  a = await ask('stream breaking bad on hulu', { chatId: a.chatId });
  ok(a.played && a.played.status === 'not_on_service', '/ask "stream breaking bad on hulu" -> not_on_service');
  // 17. "play X on YouTube" through /ask (rule parser) uses the search flow when YT_MODE=search
  process.env.YT_MODE = 'search'; PLAY.configure({ tv: ptv, power });
  a = await ask('play underwater by rüfüs du sol on youtube', { chatId: a.chatId });
  ok(a.played && a.played.status === 'searching' && /Searching YouTube for underwater by rüfüs du sol and playing the top result/i.test(a.answer || a.text || ''), '/ask "play underwater by rüfüs du sol on youtube" -> ' + (a.answer || a.text));
  relay.server.close(); relay.tvPower.stop(); relay.tv.close(); ptv.close();
  svc.close(); TV.close(); fs.rmSync(data, { recursive: true, force: true });
  console.log('play: ' + pass + ' passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
