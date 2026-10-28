// Headless test (Chrome): Ambient/Discover navigation, rapid input, transitions, data fallbacks (snapshot / mock / live
// with fixtures / stale-while-revalidate), Trakt device flow (fixtures), launch chain, cache migration, key-to-visual
// latency, blur modes. No real API calls are made: TMDB/OMDb/Trakt are answered by fixtures. Run: node tools/test-nav.js
const path = require('path'), http = require('http'), fs = require('fs');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
const root = path.resolve(__dirname, '..');
const base = 'file://' + path.join(root, 'index.html');
let fails = 0;
const check = (label, ok, extra) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined && !ok ? '  ' + JSON.stringify(extra) : '')); };

// tiny static server; /js/config.js gets fake test keys appended when the URL has ?keys=...
function serve() {
  return new Promise(res => {
    const srv = http.createServer((q, r) => {
      const u = new URL(q.url, 'http://x'); let f = path.join(root, decodeURIComponent(u.pathname));
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
      let body = fs.readFileSync(f);
      const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream';
      r.writeHead(200, { 'Content-Type': ct }); r.end(body);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}
const ok = (body) => ({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
// TMDB fixtures: 6 trending titles (FIXTURE · …), providers on our apps, runtimes, IMDb ids, one trailer
const FIX = [
  [101, 'tv', 'FIXTURE · Desk Jokes', [35], 8, 24, 'tt0000101', 'ytkey101'],
  [102, 'movie', 'FIXTURE · Picnic', [10751, 35], 337, 98, 'tt0000102', null],
  [103, 'tv', 'FIXTURE · Signal', [18, 9648], 350, 48, 'tt0000103', 'ytkey103'],
  [104, 'tv', 'FIXTURE · Gloom', [27], 15, 45, 'tt0000104', null],
  [105, 'tv', 'FIXTURE · Small Wins', [35, 10751], 386, 28, 'tt0000105', null],
  [106, 'movie', 'FIXTURE · Long Haul', [18], 1899, 151, 'tt0000106', null],
  [107, 'tv', 'FIXTURE · Brunch Club', [35, 18], 8, 32, 'tt0000107', null]];
async function fixtures(page, gen) {
  let delay = 0; const calls = { tmdb: 0, omdb: 0, trakt: [] };
  await page.route('https://api.themoviedb.org/**', async route => {
    calls.tmdb++; if (delay) await new Promise(r => setTimeout(r, delay));
    const u = new URL(route.request().url());
    if (u.pathname.includes('/trending/')) {
      const page2 = u.searchParams.get('page') === '2', tvOnly = u.pathname.includes('/tv/');
      const rows = page2 ? [] : FIX.filter(f => !tvOnly || f[1] === 'tv').map(f => ({ id: f[0], media_type: f[1], [f[1] === 'tv' ? 'name' : 'title']: f[2] + (gen.v > 1 ? ' v' + gen.v : ''),
        [f[1] === 'tv' ? 'first_air_date' : 'release_date']: '2026-01-01', genre_ids: f[3], overview: 'Fixture synopsis.', poster_path: null, vote_average: 7.9, vote_count: 900 }));
      return route.fulfill(ok({ results: rows }));
    }
    if (u.pathname.includes('/discover/')) {   // per-service catalogue: filter by kind, provider ids, genres
      const kind = u.pathname.includes('/tv') ? 'tv' : 'movie', provs = (u.searchParams.get('with_watch_providers') || '').split('|').map(Number);
      const wg = +(u.searchParams.get('with_genres') || 0), wo = (u.searchParams.get('without_genres') || '').split(',').map(Number);
      gen.discover = (gen.discover || 0) + 1;
      const rows = u.searchParams.get('page') === '2' ? [] : FIX.filter(f => f[1] === kind && provs.indexOf(f[4]) >= 0 && (!wg || f[3].indexOf(wg) >= 0) && !f[3].some(g => wo.indexOf(g) >= 0))
        .map(f => ({ id: f[0], [kind === 'tv' ? 'name' : 'title']: f[2] + (gen.v > 1 ? ' v' + gen.v : ''), [kind === 'tv' ? 'first_air_date' : 'release_date']: '2024-01-01',
          genre_ids: f[3], original_language: 'en', overview: 'Fixture synopsis.', poster_path: null, vote_average: 7.9, vote_count: 900, popularity: 100 - f[0] }));
      return route.fulfill(ok({ results: rows }));
    }
    const id = +u.pathname.split('/').pop(), f = FIX.find(x => x[0] === id);
    if (!f) return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill(ok({ runtime: f[5], episode_run_time: [f[5]], number_of_seasons: 2, imdb_id: f[6], external_ids: { imdb_id: f[6] },
      videos: { results: f[7] ? [{ site: 'YouTube', type: 'Trailer', key: f[7] }] : [] },
      'watch/providers': { results: { US: { flatrate: [{ provider_id: f[4], provider_name: 'x' }] } } } }));
  });
  await page.route('https://www.omdbapi.com/**', route => { calls.omdb++; // only the movie Picnic (tt0000102) has a Rotten Tomatoes score, so the RT badge must appear on that card alone
    const i = new URL(route.request().url()).searchParams.get('i');
    return route.fulfill(ok(Object.assign({ imdbRating: '8.3', imdbVotes: '12,345' }, i === 'tt0000102' ? { Ratings: [{ Source: 'Internet Movie Database', Value: '8.3/10' }, { Source: 'Rotten Tomatoes', Value: '92%' }] } : {}))); });
  await page.route('https://api.trakt.tv/**', async route => {
    const u = new URL(route.request().url()); calls.trakt.push(u.pathname + ' ' + (route.request().postData() || ''));
    if (u.pathname === '/oauth/device/code') return route.fulfill(ok({ device_code: 'DEV', user_code: 'AB12CD34', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 1 }));
    if (u.pathname === '/oauth/device/token') { gen.polls = (gen.polls || 0) + 1;
      if (gen.deny) return route.fulfill({ status: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"invalid_client"}' });
      return gen.polls < 2 ? route.fulfill({ status: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' })
        : route.fulfill(ok({ access_token: 'AT', refresh_token: 'RT', created_at: Math.floor(Date.now() / 1000), expires_in: 604800 })); }
    if (gen.empty && u.pathname.startsWith('/sync/')) return route.fulfill(ok([]));
    if (u.pathname === '/sync/watched/shows' && gen.watched) return route.fulfill(ok([{ show: { title: 'x', ids: { tmdb: gen.watched } } }]));
    if (u.pathname === '/users/settings') return route.fulfill(ok({ user: { username: 'tester' } }));
    if (u.pathname === '/sync/playback') return route.fulfill(ok([{ type: 'episode', progress: 40, paused_at: '2026-10-27T01:00:00Z',
      show: { title: 'FIXTURE · Desk Jokes', ids: { tmdb: 101 } }, episode: { season: 1, number: 3, title: 'Copier', runtime: 24 } }]));
    return route.fulfill(ok([]));
  });
  return { calls, setDelay: d => { delay = d; } };
}

(async () => {
  const srv = await serve(); const httpBase = 'http://127.0.0.1:' + srv.address().port + '/index.html';
  const browser = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  const st = () => page.evaluate(() => {
    const f = RH_debug.focus, r = RH_debug.rows[f.r], d = r.data[f.i];
    return { kind: r.kind, i: f.i, what: d && (typeof d === 'string' ? d : d.item ? d.item.title : d.title || d[0]), discover: RH_debug.discoverOn,
      toast: document.getElementById('toast').textContent, credit: document.body.classList.contains('show-credit'), hint: document.body.classList.contains('hint-on') };
  });
  const key = async (k, n = 1) => { for (let j = 0; j < n; j++) { await page.keyboard.press(k); await page.waitForTimeout(90); } };
  const tvKey = (code) => page.evaluate(c => { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => c }); document.dispatchEvent(e); }, code);
  // dock=1 pins the dock (pre-v2 behaviour) and tab=tv fixes the Discover tab, so the older checks stay deterministic;
  // section 1b tests the hidden dock and the Movies | Shows tabs explicitly (pass q with 'nodock' to skip the pin).
  const pinQ = q => { q = q || ''; if (/nodock/.test(q)) return q; return q + (q ? '&' : '?') + 'dock=1' + (/tab=/.test(q) ? '' : '&tab=tv'); };
  const fresh = async (url, q) => { q = pinQ(q); await page.goto(url + q); await page.evaluate(() => localStorage.clear()); await page.goto(url + q); await page.waitForTimeout(700); };
  // Open-Meteo fixture (Ambient weather): never the real network in tests
  const dstr = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const WX = { current: { time: dstr(0) + 'T12:00', temperature_2m: 64.4, weather_code: 2, is_day: 1 },
    daily: { time: [dstr(0), dstr(1), dstr(2)], weather_code: [2, 61, 0], temperature_2m_max: [70.1, 61.6, 72.9], temperature_2m_min: [50.2, 49.4, 51] } };
  const wxState = { fail: false, calls: 0 };
  await ctx.route('https://api.open-meteo.com/**', r => { wxState.calls++; return wxState.fail ? r.abort() : r.fulfill(ok(WX)); });
  const picks = () => page.evaluate(() => { const s = RH_debug.picks(); return { mode: s.mode, titles: s.picks.map(p => p.item.title), labels: s.picks.map(p => p.label),
    src: document.getElementById('pkSrc').textContent, cards: document.querySelectorAll('#pkTrack .card').length }; });

  /* ---------- 1. Offline (no keys): snapshot picks, Ambient <-> Discover ---------- */
  await fresh(base, '?still=1');
  let s = await st(); check('boot focus = dock[0] YouTube, Ambient', s.kind === 'apps' && s.what === 'youtube' && !s.discover, s);
  check('wake hint visible ("… ↑")', s.hint && /\u2191/.test(await page.textContent('#hint')), await page.textContent('#hint'));
  let p = await picks();
  check('snapshot: exactly 3 picks with the 3 slot labels', p.cards === 3 && p.labels.join('|') === "Easy Laugh|Feel-Good Tonight|Trending & Worth It", p);
  check('snapshot source labelled with date', /IMDb .*snapshot .*ratings as of/.test(p.src), p.src);
  check('Continue Watching hidden without Trakt', await page.evaluate(() => document.querySelectorAll('#cwTrack .cwi').length === 0 && getComputedStyle(document.getElementById('cw')).display === 'none'));
  check('picks not marked "seen" until Discover opens', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('rh.dsc.shown') || '{}')).length === 0));
  const flt = await page.evaluate(() => {
    const T = (id, kind, genres, lang, rt, extra) => Object.assign({ id, kind, title: id, genres, lang, runtimeMin: rt, rank: 1, trending: true, trendRank: 1, rating: 8.5, ratingSource: 'IMDb', ratingVotes: 50000, app: 'netflix' }, extra || {});
    const pool = { mode: 'live', liveProviders: true, items: [
      T('anime', 'tv', ['Animation', 'Action & Adventure', 'Comedy'], 'ja', 24), T('animeFam', 'tv', ['Animation', 'Comedy', 'Family'], 'ja', 24),
      T('actionCom', 'tv', ['Action & Adventure', 'Comedy'], 'en', 30), T('crime', 'movie', ['Crime', 'Comedy'], 'en', 100),
      T('drama', 'tv', ['Drama'], 'en', 30), T('noApp', 'tv', ['Comedy'], 'en', 25, { app: null }),
      T('sitcom', 'tv', ['Comedy'], 'en', 22, { trending: false, trendRank: null, rank: 30 }), T('romcom', 'movie', ['Romance', 'Comedy'], 'en', 100, { trending: false, trendRank: null, rank: 31 }),
      T('trendCom', 'tv', ['Comedy', 'Drama'], 'en', 45, { rating: 7.6 }), T('lowRated', 'tv', ['Comedy'], 'en', 30, { rating: 6.2 })] };
    return RH_Discover._choose(pool, { weeknight: true }).map(p => p.slot + '=' + p.item.id).join(' ');
  });
  check('scoring: no anime/action/crime/drama-only/unavailable; laugh=sitcom, feel=romcom, trend=trending comedy', flt === 'laugh=sitcom feel=romcom trend=trendCom', flt);
  await key('ArrowRight', 5); s = await st(); check('right x5 -> appletv', s.what === 'appletv', s);
  await key('ArrowRight', 4); s = await st(); check('right clamps at disney', s.what === 'disney', s);
  await key('ArrowLeft', 4); s = await st(); check('left x4 -> prime', s.what === 'prime', s);
  await key('ArrowUp'); s = await st(); check('Up from dock -> Discover, middle pick focused', s.discover && s.kind === 'picks' && s.i === 1, s);
  check('hint hidden in Discover', !s.hint);
  check('picks marked seen once Discover is open', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('rh.dsc.shown') || '{}')).length === 3));
  check('dock hidden in Discover', await page.evaluate(() => !document.body.classList.contains('dock-on')));
  check('greeting subline shown', (await page.textContent('#dscSub')).length > 5, await page.textContent('#dscSub'));
  check('focused card shows its actions, others do not', await page.evaluate(() => getComputedStyle(document.querySelector('#pkTrack .card.is-focused .card-acts')).opacity !== '0' &&
    getComputedStyle(document.querySelector('#pkTrack .card:not(.is-focused) .card-acts')).opacity === '0'));
  check('card: title, year/runtime, genre line and rating badge only', await page.evaluate(() => { const c = document.querySelector('#pkTrack .card');
    return !!c.querySelector('.card-t') && !!c.querySelector('.card-y') && !c.querySelector('.card-p') && !c.querySelector('.card-k') && (!c.querySelector('.rate') || /^(IMDb|TMDB)/.test(c.querySelector('.rate').textContent)); }));
  await key('ArrowLeft'); await key('ArrowLeft'); s = await st(); check('picks: left clamps at first card', s.kind === 'picks' && s.i === 0, s);
  await key('ArrowDown'); s = await st(); check('Down from card -> its action row', s.kind === 'acts', s);
  const acts = await page.evaluate(() => [].map.call(document.querySelectorAll('.card.is-focused .act, .card-acts .act'), a => a.getAttribute('data-a')));
  check('snapshot card actions never claim "Watch"', !(await page.textContent('#pkTrack')).match(/\bWatch\b(?! )/) && acts.indexOf('dismiss') >= 0, acts);
  await key('ArrowUp'); s = await st(); check('Up from actions -> parent card', s.kind === 'picks' && s.i === 0, s);
  await key('ArrowUp'); s = await st(); check('Up from picks -> current tab (Shows)', s.kind === 'tabs' && s.what === 'tv', s);
  await key('ArrowRight'); s = await st(); check('Right from Shows -> Refresh pill', s.kind === 'tabs' && s.what === 'refresh', s);
  const before = (await picks()).titles; await key('Enter'); await page.waitForTimeout(150);
  const after = (await picks()).titles; check('Refresh shows different picks', after.join() !== before.join(), [before, after]);
  await key('ArrowDown'); s = await st(); check('Down from Refresh -> picks', s.kind === 'picks', s);
  // dismiss: card 0 -> acts -> move to Dismiss -> Enter
  const t0 = (await picks()).titles[s.i];
  await key('ArrowDown'); let idx = await page.evaluate(() => [].map.call(document.querySelectorAll('.card.is-focused .act, .card-acts .act'), a => a.getAttribute('data-a')).indexOf('dismiss'));
  await key('ArrowRight', Math.max(0, idx)); await key('Enter'); await page.waitForTimeout(150);
  p = await picks(); check('Not interested removes the title and keeps 3 cards', p.titles.indexOf(t0) < 0 && p.cards === 3, [t0, p.titles]);
  check('dismiss persisted', await page.evaluate(t => Object.keys(JSON.parse(localStorage.getItem('rh.dsc.dismissed') || '{}')).length === 1, t0));
  await page.reload(); await page.waitForTimeout(600);
  check('dismissed title never returns after reload', (await picks()).titles.indexOf(t0) < 0);
  await key('ArrowUp'); await key('Escape'); s = await st(); check('Back in Discover -> Ambient (dock)', !s.discover && s.kind === 'apps', s);
  await key('ArrowUp'); await key('ArrowDown'); await key('ArrowDown'); s = await st(); check('Down x2 from picks -> dock, Ambient', !s.discover && s.kind === 'apps', s);

  /* ---------- 1b. v2: hidden dock, Ambient weather, Movies | Shows tabs ---------- */
  await fresh(base, '?still=1&nodock&tab=movie'); await page.waitForTimeout(400);
  const dk = () => page.evaluate(() => ({ on: RH_debug.dockOn, cls: document.body.classList.contains('dock-on'), op: +getComputedStyle(document.querySelector('.row-dock')).opacity }));
  let d = await dk(); check('Ambient: dock hidden by default', !d.on && !d.cls, d);
  check('Ambient: big time + date shown', await page.evaluate(() => /\d:\d\d/.test(document.getElementById('ambTime').textContent) && document.getElementById('ambDate').textContent.length > 5));
  let wx = await page.evaluate(() => ({ on: document.getElementById('wx').classList.contains('on'), t: document.getElementById('wx').textContent }));
  check('weather: current temp + condition + 2 forecast days (Open-Meteo fixture)', wx.on && /64°/.test(wx.t) && /Partly cloudy/.test(wx.t) && /62°/.test(wx.t) && /73°/.test(wx.t) && !/70°/.test(wx.t), wx);
  check('weather cached in localStorage', await page.evaluate(() => !!JSON.parse(localStorage.getItem('rh.wx') || 'null')));
  await key('ArrowRight'); d = await dk(); s = await st(); check('first arrow only reveals the dock (focus unchanged)', d.cls && s.what === 'youtube', [d, s]);
  await key('ArrowRight'); s = await st(); check('revealed dock: Right moves', s.what === 'netflix', s);
  await key('Escape'); d = await dk(); s = await st(); check('Back hides the revealed dock (no exit prompt)', !d.cls && !/exit/.test(s.toast), [d, s]);
  await key('ArrowDown'); d = await dk(); check('Down reveals the dock', d.cls, d);
  await key('ArrowUp'); s = await st(); d = await dk(); check('Up from the revealed dock -> Discover (dock hidden)', s.discover && !d.cls, [s, d]);
  check('Discover starts on the Movies tab (?tab=movie)', await page.evaluate(() => RH_debug.tab === 'movie' && document.getElementById('tabMovie').classList.contains('on')));
  p = await picks(); check('Movies tab: 1-3 movie cards only', p.cards >= 1 && p.cards <= 3 && (await page.evaluate(() => RH_debug.picks().picks.every(x => x.item.kind === 'movie'))), p);
  await key('ArrowUp'); s = await st(); check('Up from picks -> Movies tab', s.kind === 'tabs' && s.what === 'movie', s);
  await key('ArrowRight'); await page.waitForTimeout(150); s = await st();
  check('Right -> Shows tab switches to shows', s.what === 'tv' && (await page.evaluate(() => RH_debug.tab === 'tv' && RH_debug.picks().picks.every(x => x.item.kind === 'tv'))), s);
  p = await picks(); check('Shows tab: max 3 cards', p.cards >= 1 && p.cards <= 3, p);
  await key('ArrowDown'); s = await st(); check('Down from tabs -> picks', s.kind === 'picks', s);
  await key('ArrowDown'); await key('ArrowDown'); s = await st(); d = await dk(); check('Down from picks -> revealed dock', s.kind === 'apps' && d.cls, [s, d]);
  await key('Enter'); await page.waitForTimeout(300); s = await st(); check('Enter on the dock still launches', /Launching|launch|Preview/i.test(s.toast) || await page.evaluate(() => Object.keys(localStorage).some(k => /^rh\.appid\./.test(k))), s);
  await fresh(base, '?still=1&nodock&dockhide=1'); await page.evaluate(() => { RH_CONFIG.dockAutoHideSec = 0.6; });
  await key('ArrowUp'); d = await dk(); check('Up from hidden dock reveals it (no Discover yet)', d.cls && !(await st()).discover, d);
  await page.waitForTimeout(1000); d = await dk(); check('dock auto-hides after the idle timeout', !d.cls, d);
  await key('Escape'); s = await st(); check('Back with dock hidden keeps the double-Back exit', s.toast === 'Press Back again to exit', s);
  wxState.fail = true; await fresh(base, '?still=1&nodock'); await page.waitForTimeout(300);
  wx = await page.evaluate(() => ({ on: document.getElementById('wx').classList.contains('on'), t: document.getElementById('wx').textContent }));
  check('weather: no data -> block hidden, no numbers', !wx.on && !/\d/.test(wx.t), wx); wxState.fail = false;

  /* ---------- 2. Rapid input + interruptible transitions + latency ---------- */
  const rapid = await page.evaluate(() => {
    const send = c => { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => c }); document.dispatchEvent(e); };
    RH_debug.setFocus(RH_debug.rowIndex('apps'), 0, true);
    const t = performance.now(); for (let i = 0; i < 40; i++) send(39); for (let i = 0; i < 3; i++) send(37);
    const ms = performance.now() - t, f = RH_debug.focus; return { ms, i: f.i, kind: RH_debug.rows[f.r].kind };
  });
  check('40 rapid Rights + 3 Lefts settle immediately (no queue): focus on tile 4', rapid.kind === 'apps' && rapid.i === 4, rapid);
  check('43 key handlers ran in < 60 ms total', rapid.ms < 60, rapid.ms.toFixed(1));
  const flip = await page.evaluate(() => new Promise(res => {
    const send = c => { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => c }); document.dispatchEvent(e); };
    send(38); setTimeout(() => { send(27); setTimeout(() => res({ on: RH_debug.discoverOn, op: +getComputedStyle(document.getElementById('discover')).opacity }), 250); }, 60);
  }));
  check('Up then Back mid-transition retargets back to Ambient', !flip.on && flip.op < 0.5, flip);
  const lat = await page.evaluate(() => new Promise(res => {
    const out = []; const send = c => { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => c }); document.dispatchEvent(e); };
    let n = 0; (function one() {
      const t = performance.now(); send(n % 2 ? 37 : 39); const h = performance.now() - t;
      requestAnimationFrame(() => requestAnimationFrame(() => { out.push([h, performance.now() - t]); if (++n < 20) setTimeout(one, 30); else res(out); }));
    })();
  }));
  const hMax = Math.max(...lat.map(x => x[0])), fMed = lat.map(x => x[1]).sort((a, b) => a - b)[10];
  console.log('     key handler max ' + hMax.toFixed(1) + ' ms; key -> painted frame median ' + fMed.toFixed(1) + ' ms (headless, 60 Hz)');
  check('key -> visual under 50 ms', hMax < 8 && fMed < 50, { hMax, fMed });
  const ft = await page.evaluate(() => { const el = document.querySelector('.tile.is-focused'); const cs = getComputedStyle(el);
    return { outline: cs.outlineStyle, tp: cs.transitionProperty, dur: cs.transitionDuration }; });
  check('focus animates transform only, 120-160 ms', ft.outline === 'none' && /transform/.test(ft.tp) && !/width|height|left|top|box-shadow/.test(ft.tp) &&
    ft.dur.split(',').every(d => parseFloat(d) >= 0.12 && parseFloat(d) <= 0.16), ft);
  await fresh(base, '?reduce=1'); await key('ArrowUp');
  check('reduced motion: Discover appears without transition', await page.evaluate(() => getComputedStyle(document.getElementById('discover')).transitionDuration.split(',').every(d => parseFloat(d) < 0.01)));

  /* ---------- 3. Mock and no-data fallbacks ---------- */
  await fresh(base, '?mock=1'); p = await picks();
  check('?mock=1: MOCK chip and MOCK titles', p.mode === 'mock' && /MOCK/.test(p.src) && p.titles.every(t => /^MOCK/.test(t)), p);
  check('?mock=1: Continue Watching shows 1-2 MOCK items', await page.evaluate(() => { const n = document.querySelectorAll('#cwTrack .cwi').length; return n >= 1 && n <= 2 && /MOCK/.test(document.getElementById('cwTrack').textContent); }));
  await key('ArrowUp'); s = await st(); check('Up from dock -> Resume first (CW priority)', s.kind === 'cw' && s.i === 0, s);
  await key('Enter'); await page.waitForTimeout(150); s = await st(); check('Resume opens the app (no fake deep link)', /Preview|Opening|Netflix/i.test(s.toast), s.toast);
  await fresh(base, '?discover=0'); await key('ArrowUp'); s = await st();
  check('?discover=0: no Discover, no hint, Up does nothing harmful', !s.discover && !s.hint, s);
  await fresh(base, ''); await page.evaluate(() => { localStorage.setItem('rh.dsc.dismissed', JSON.stringify(Object.fromEntries(RH_Discover._snapshot().items.map(i => [i.id, Date.now()])))); });
  await page.reload(); await page.waitForTimeout(600); p = await picks(); s = await st();
  check('everything dismissed: picks hidden, no hint, no errors', p.cards === 0 && !s.hint, p);

  /* ---------- 4. Live path (fixtures; fake keys) + stale-while-revalidate ---------- */
  const gen = { v: 1 }; let fx = await fixtures(page, gen);
  await page.route('**/js/config.js', async route => { const r = await route.fetch(); let b = await r.text();
    b += "\nRH_CONFIG.keys.tmdbApiKey='TEST'; RH_CONFIG.keys.omdbApiKey='TEST'; RH_CONFIG.keys.traktClientId='TESTCID';"; route.fulfill({ response: r, body: b }); });
  await fresh(httpBase, '?still=1'); await page.waitForTimeout(1200); p = await picks();
  // v3: one streaming service per page (TMDB discover with_watch_providers, US flatrate); Netflix first (default order)
  check('platform page: Netflix first, its shows only (TMDB discover fixture)', p.mode === 'live' && (await page.evaluate(() => RH_debug.platform)) === 'netflix' &&
    p.cards === 2 && p.titles.join('|') === 'FIXTURE · Desk Jokes|FIXTURE · Brunch Club', p);
  check('platform: rank labels #1 #2', p.labels.join('|') === '#1|#2', p.labels);
  check('platform source label "Top shows on Netflix (US) · ranked by IMDb + Rotten Tomatoes via OMDb · updated …"', /^Top shows on Netflix \(US\) \u00b7 ranked by IMDb( \+ Rotten Tomatoes)? via OMDb \u00b7 updated \w{3} \d+, \d{4}$/.test(p.src), p.src);
  check('live: OMDb consulted, IMDb rating shown', fx.calls.omdb > 0 && /IMDb 8\.3/.test(await page.textContent('#pkTrack')));
  check('no Rotten Tomatoes badge without an RT score', await page.evaluate(() => !document.querySelector('#pkTrack .rate.rt')));
  check('card year line shows seasons for shows', /2024 \u00b7 2 seasons/.test(await page.textContent('#pkTrack')), await page.textContent('#pkTrack'));
  check('live: provider shown as "Open in Netflix"', /Open in Netflix/.test(await page.textContent('#pkTrack')));
  check('live: Trailer action only where a YouTube trailer exists', await page.evaluate(() => [].every.call(document.querySelectorAll('#pkTrack .card'), c => {
    const t = c.querySelector('[data-a="trailer"]'); const i = +c.getAttribute('data-i'); const it = RH_debug.picks().picks[i].item; return !!t === !!it.trailer; })));
  check('platform result cached (rh.dsc.plat.netflix)', await page.evaluate(() => !!JSON.parse(localStorage.getItem('rh.dsc.plat.netflix') || 'null')));
  await page.waitForTimeout(2500);
  check('neighbouring services prefetched (HBO Max + Disney+)', await page.evaluate(() => !!localStorage.getItem('rh.dsc.plat.hbomax') && !!localStorage.getItem('rh.dsc.plat.disney')));
  check('platform header visible: chip + name + 7 dots', await page.evaluate(() => getComputedStyle(document.getElementById('plat')).display !== 'none' &&
    document.getElementById('platName').textContent === 'Netflix' && document.querySelectorAll('#platDots i').length === 7 && document.querySelectorAll('#platDots i.on').length === 1));
  check('platform mode hides the Refresh pill', await page.evaluate(() => getComputedStyle(document.getElementById('refresh')).display === 'none'));
  await key('ArrowUp', 3); s = await st(); check('Up from dock -> picks -> tab -> platform header', s.kind === 'plat', s);
  await key('ArrowRight'); await page.waitForTimeout(60);
  const ghost = await page.evaluate(() => { const g = document.querySelector('#pkStage .pk-ghost'); if (!g) return null; const cs = getComputedStyle(g); return { tp: cs.transitionProperty, dur: cs.transitionDuration }; });
  check('carousel: old page slides out as a transform/opacity-only ghost (~300 ms)', !!ghost && ghost.tp.split(',').every(x => /transform|opacity/.test(x)) &&
    ghost.dur.split(',').every(d => parseFloat(d) >= 0.2 && parseFloat(d) <= 0.35), ghost);
  await page.waitForTimeout(500);
  s = await st(); check('Right on the header -> HBO Max page (focus stays on header)', (await page.evaluate(() => RH_debug.platform)) === 'hbomax' && s.kind === 'plat', s);
  check('ghost removed after the slide', await page.evaluate(() => !document.querySelector('#pkStage .pk-ghost')));
  check('no backdrop-filter on carousel pieces', await page.evaluate(() => [].every.call(document.querySelectorAll('#plat, #pkStage, #pkTrack .card'), e => !/blur/.test(getComputedStyle(e).backdropFilter || ''))));
  p = await picks(); check('HBO Max has no shows in fixtures -> honest empty state, no cards', p.cards === 0 && /HBO Max/.test(await page.textContent('#picks')), p);
  await key('ArrowLeft'); await page.waitForTimeout(400); check('Left -> back to Netflix', (await page.evaluate(() => RH_debug.platform)) === 'netflix');
  await key('ArrowLeft'); await page.waitForTimeout(400); check('Left wraps to the last service (Disney+)', (await page.evaluate(() => RH_debug.platform)) === 'disney');
  await tvKey(427); await page.waitForTimeout(400); check('ChannelUp (427) -> next service (Netflix)', (await page.evaluate(() => RH_debug.platform)) === 'netflix');
  await key('ArrowDown'); await key('ArrowDown'); s = await st(); check('Down from header -> tabs -> picks', s.kind === 'picks', s);
  await page.evaluate(() => RH_debug.setFocus(RH_debug.rowIndex('picks'), RH_debug.picks().picks.length - 1));
  await key('ArrowRight'); await page.waitForTimeout(500); check('Right past the last card slides to the next service', (await page.evaluate(() => RH_debug.platform)) === 'hbomax');
  await fresh(httpBase, '?still=1&tab=movie&plat=disney'); await page.waitForTimeout(1500); p = await picks();
  check('?plat=disney Movies: Picnic', (await page.evaluate(() => RH_debug.platform)) === 'disney' && p.titles.join() === 'FIXTURE · Picnic', p);
  check('Rotten Tomatoes badge (tomato + 92%) shown only where OMDb has an RT score', await page.evaluate(() => { const r = document.querySelector('#pkTrack .rate.rt');
    return !!r && /92%/.test(r.textContent) && !!r.querySelector('svg'); }));
  check('Open in Disney+ launches the service', /Open in Disney\+/.test(await page.textContent('#pkTrack')));
  // stale cache -> paints cached instantly, refreshes in background (slow network), applies when Discover closes
  await fresh(httpBase, '?still=1'); await page.waitForTimeout(1500);
  await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('rh.dsc.plat.netflix')); c.fetchedAt = '2026-10-01T00:00:00Z'; localStorage.setItem('rh.dsc.plat.netflix', JSON.stringify(c)); });
  gen.v = 2; fx.setDelay(700); await page.reload(); await page.waitForTimeout(250);
  p = await picks(); check('stale cache paints instantly (before network returns)', p.mode === 'live' && p.cards === 2 && p.titles.every(t => !/ v2$/.test(t)), p);
  await key('ArrowUp'); await page.waitForTimeout(3500); p = await picks();
  check('background refresh does not swap cards under focus', p.titles.every(t => !/ v2$/.test(t)), p);
  await key('Escape'); await page.waitForTimeout(100); p = await picks();
  check('refreshed picks applied once Discover closes', p.titles.some(t => / v2$/.test(t)), p);
  fx.setDelay(0); gen.v = 1;
  // network down + no cache -> snapshot
  await page.route('https://api.themoviedb.org/**', r => r.abort()); await page.evaluate(() => Object.keys(localStorage).filter(k => /^rh\.dsc\.(live|plat\.)/.test(k)).forEach(k => localStorage.removeItem(k)));
  await page.reload(); await page.waitForTimeout(800); p = await picks();
  check('TMDB down, no cache -> dated IMDb snapshot', p.mode === 'snapshot' && p.cards === 3, p);
  await page.unroute('https://api.themoviedb.org/**');
  await page.unroute('https://www.omdbapi.com/**'); await page.unroute('https://api.trakt.tv/**'); fx = await fixtures(page, gen);   // fixtures back for section 5

  /* ---------- 5. Trakt status + device flow (client id only, no secret) + history ---------- */
  await fresh(httpBase, '?still=1'); await page.waitForTimeout(600);
  check('Trakt not linked: no Resume row, one-line status "Trakt not linked"', await page.evaluate(() => document.querySelectorAll('#cwTrack .cwi').length === 0) &&
    /^Trakt not linked/.test(await page.textContent('#tstat')), await page.textContent('#tstat'));
  await key('ArrowUp'); s = await st(); check('status line does not steal first focus (picks first)', s.kind === 'picks', s);
  await key('ArrowUp', 3); s = await st(); check('Up reaches the Trakt status ("Link") via tabs + platform header', s.kind === 'trakt', s);
  await key('Enter'); await page.waitForTimeout(300);
  check('device flow shows code + activate URL in the status line', /trakt\.tv\/activate/.test(await page.textContent('#tstat')) && /AB12CD34/.test(await page.textContent('#tstat')), await page.textContent('#tstat'));
  await page.waitForTimeout(2600);
  check('approval stores tokens; no secret ever sent', await page.evaluate(() => !!JSON.parse(localStorage.getItem('rh.trakt.auth') || 'null')) &&
    fx.calls.trakt.filter(c => c.startsWith('/oauth/')).every(c => c.indexOf('client_secret') < 0), fx.calls.trakt);
  await page.waitForTimeout(800);
  check('after link: Resume Watching shows the paused episode', /Desk Jokes/.test(await page.textContent('#cwTrack')), await page.textContent('#cwTrack'));
  check('status reads "Trakt linked · 1 to resume"', /^Trakt linked.* \u00b7 1 to resume/.test(await page.textContent('#tstat')), await page.textContent('#tstat'));
  check('Trakt history/recommendations consulted', ['/sync/history', '/sync/watched/shows', '/recommendations/'].every(x => fx.calls.trakt.some(c => c.indexOf(x) >= 0)), fx.calls.trakt);
  await key('Escape'); await key('ArrowUp'); s = await st(); check('Resume Watching comes first (Up from dock)', s.kind === 'cw' && s.i === 0, s);
  // linked, but empty account
  gen.empty = true; await page.evaluate(() => { localStorage.removeItem('rh.dsc.cw'); }); await page.reload(); await page.waitForTimeout(1200);
  check('linked + empty account: "Trakt linked · no history yet", no Resume row', /^Trakt linked.* \u00b7 no history yet/.test(await page.textContent('#tstat')) &&
    await page.evaluate(() => document.querySelectorAll('#cwTrack .cwi').length === 0), await page.textContent('#tstat'));
  gen.empty = false;
  // watched show is excluded from picks
  gen.watched = 107; await page.evaluate(() => { Object.keys(localStorage).filter(k => /^rh\.dsc\.(live|plat\.|hist|last\.|trakt)/.test(k)).forEach(k => localStorage.removeItem(k)); });
  await page.reload(); await page.waitForTimeout(1800); p = await picks();
  check('show already watched on Trakt never picked', p.titles.indexOf('FIXTURE · Brunch Club') < 0 && p.titles.indexOf('FIXTURE · Desk Jokes') >= 0, p);
  gen.watched = 0;
  // a Trakt app that refuses device sign-in without a secret
  gen.deny = true; gen.polls = 0; await fresh(httpBase, '?still=1'); await page.waitForTimeout(500);
  await page.evaluate(() => RH_debug.setFocus(RH_debug.rowIndex('trakt'), 0)); await key('Enter'); await page.waitForTimeout(2500);
  check('device sign-in refused -> status says so and points at tools/trakt-link.sh', /^Trakt not linked.*trakt-link\.sh/.test(await page.textContent('#tstat')) &&
    await page.evaluate(() => !localStorage.getItem('rh.trakt.auth')), await page.textContent('#tstat'));
  gen.deny = false;
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  /* ---------- 5b. Hint text, refresh rotation, Not interested via Yellow ---------- */
  await fresh(base, '?still=1');
  check('wake hint reads "3 picks for tonight ↑"', (await page.textContent('#hint')).trim() === '3 picks for tonight \u2191', await page.textContent('#hint'));
  await page.waitForTimeout(300); check('Discover never opens by itself', !(await st()).discover);
  await key('ArrowUp'); const seenT = new Set((await picks()).titles); let rep = false, rounds = 0, lastTitles = null;
  for (let k = 0; k < 6; k++) {
    await page.evaluate(() => RH_debug.refresh()); await page.waitForTimeout(150); const t = (await picks()).titles;
    if (lastTitles && t.join() === lastTitles.join()) break;
    rounds++; if (t.some(x => seenT.has(x))) rep = true; t.forEach(x => seenT.add(x)); lastTitles = t;
  }
  check('Refresh rotates to new picks, never repeating within the session', rounds >= 1 && !rep, { rounds, rep, seen: [...seenT] });
  check('exhausted session keeps the best cards + says so', /No new picks left/.test((await st()).toast) || rounds >= 6, (await st()).toast);
  await fresh(base, '?still=1'); await key('ArrowUp'); p = await picks(); const yT = p.titles[1];
  await tvKey(405); await page.waitForTimeout(200); s = await st(); p = await picks();
  check('Yellow on a card = Not interested (title gone, persisted, toast)', p.titles.indexOf(yT) < 0 && p.cards === 3 && /Not interested/.test(s.toast) && !s.credit &&
    await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('rh.dsc.dismissed') || '{}')).length === 1), [yT, p.titles, s]);
  check('card action row has "Not interested"', /Not interested/.test(await page.textContent('#pkTrack')));
  check('choice tracking: prefs stored', await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('rh.dsc.prefs') || 'null'); return !!p && !!p.kinds; }));
  check('last picks (per tab) + art cached for offline paint', await page.evaluate(() => !!localStorage.getItem('rh.dsc.last.tv')));

  /* ---------- 5c. Idle / always-on ---------- */
  await fresh(base, '?still=1&idlescale=0.05');            // 1 "minute" = 50 ms -> idle after 0.5 s, 2nd dim step 1 s later
  await page.waitForTimeout(900);
  let idl = await page.evaluate(() => ({ on: RH_debug.idle, op: +getComputedStyle(document.getElementById('rows')).opacity, dim: document.getElementById('dim').style.opacity }));
  check('idle after N minutes: UI faded, dim overlay applied', idl.on && idl.op < 0.99, idl);
  await page.waitForTimeout(2500);
  idl = await page.evaluate(() => ({ on: RH_debug.idle, op: +getComputedStyle(document.getElementById('rows')).opacity, dim: document.getElementById('dim').style.opacity, topbar: +getComputedStyle(document.querySelector('.topbar')).opacity }));
  check('idle: dock + clock fully hidden, dim at 35% brightness', idl.op === 0 && idl.topbar === 0 && Math.abs(+idl.dim - 0.65) < 0.01, idl);
  const focusBefore = await page.evaluate(() => JSON.stringify(RH_debug.focus));
  await key('ArrowRight'); idl = await page.evaluate(() => ({ on: RH_debug.idle, op: +getComputedStyle(document.getElementById('rows')).opacity, dim: +(document.getElementById('dim').style.opacity || 0) }));
  check('any key wakes instantly (UI back, no dim)', !idl.on && idl.op > 0.99 && idl.dim === 0, idl);
  check('the waking key is swallowed (focus unchanged)', await page.evaluate(() => JSON.stringify(RH_debug.focus)) === focusBefore);
  await fresh(base, '?still=1&idlescale=0.05&idle=0'); await page.waitForTimeout(900);
  check('?idle=0 disables idle', !(await page.evaluate(() => RH_debug.idle)));

  /* ---------- 6. Info / credit / Back / launch chain / cache migration ---------- */
  await fresh(base, '?still=1'); await page.waitForTimeout(1500);
  await tvKey(405); await page.waitForTimeout(150); s = await st(); check('Yellow toggles credit on', s.credit, s);
  await key('Escape'); s = await st(); check('Back with credit shown only hides credit', !s.credit && s.kind === 'apps', s);
  await key('ArrowRight'); await key('Escape'); s = await st(); check('Back -> home (YouTube)', s.what === 'youtube', s);
  await key('Escape'); s = await st(); check('Back on home arms exit', s.toast === 'Press Back again to exit', s);
  await key('Escape'); await page.waitForTimeout(100); s = await st(); check('second Back exits', s.toast === 'Preview \u00b7 launcher would exit', s);
  const expect = { youtube: '9Ur5IzDKqV.TizenYouTube', netflix: 'org.tizen.netflix-app', hbomax: '5b8c3eb16b.BeamCTVDev',
    prime: 'org.tizen.primevideo', hulu: 'LBUAQX1exg.Hulu', appletv: 'com.samsung.tv.aria-video', peacock: 'gzcc4LRFBF.Peacock', disney: 'MCmYXNxgcu.DisneyPlus' };
  await fresh(base);
  for (const k of Object.keys(expect)) {
    await page.evaluate(k => RH_debug.launchApp(k), k); await page.waitForTimeout(450);
    const got = await page.evaluate(k => localStorage.getItem('rh.appid.' + k), k);
    check('launch ' + k + ' -> ' + expect[k], got === expect[k], got);
  }
  await page.evaluate(() => { localStorage.setItem('rh.cachever', '1'); localStorage.setItem('rh.appid.hbomax', 'cj37Ni3qXM.HBONow'); });
  await page.goto(base); await page.waitForTimeout(500);
  check('cache v2 clears stale HBO id', await page.evaluate(() => localStorage.getItem('rh.appid.hbomax') === null && localStorage.getItem('rh.cachever') === '2'));
  await fresh(base, '?mock=alt');
  for (const [k, id] of [['hbomax', 'Mock00HBOM.Max'], ['peacock', 'Mock00Peac.Peacock']]) {
    await page.evaluate(k => RH_debug.launchApp(k), k); await page.waitForTimeout(900);
    check('name match ' + k + ' skips decoys -> ' + id, await page.evaluate(k => localStorage.getItem('rh.appid.' + k), k) === id);
  }

  /* ---------- 7. Glass modes (baked default) ---------- */
  await fresh(base); check('default glass mode = baked, no live backdrop-filter', await page.evaluate(() => document.body.classList.contains('blur-baked') &&
    [].every.call(document.querySelectorAll('.glass, .glass-chip'), e => !/blur/.test(getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter || ''))));
  for (const m of ['baked', 'live', 'off']) {
    await page.goto(base + '?blur=' + m); await page.waitForTimeout(400);
    const fps = await page.evaluate(() => new Promise(res => {
      let i = 0; const t = setInterval(() => RH_debug.setFocus(RH_debug.rowIndex('apps'), (i++) % 8, true), 200);
      let n = 0, t0 = 0; function f(tt) { if (!t0) t0 = tt; n++; if (tt - t0 < 2000) requestAnimationFrame(f); else { clearInterval(t); res(n * 1000 / (tt - t0)); } }
      requestAnimationFrame(f);
    }));
    console.log('     fps ' + m + ' ' + fps.toFixed(1) + ' (headless software GL; not a TV number)');
  }
  const real = errs.filter(e => !/net::ERR_FAILED|Failed to load resource/.test(e));
  check('no page/console errors', real.length === 0, real);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await browser.close(); srv.close(); process.exit(fails ? 1 : 0);
})();
