'use strict';
// Real data tools shared by both brains. Every network call happens inside ctx.step(), which streams a timeline step
// (start -> end with a short real detail and ms timing) to the TV. No invented numbers: details come from responses.
const https = require('https');
const { PLATFORMS, PROVIDER_TO_APP, ALL_PROVIDERS, GENRES, GENRE_NAMES } = require('./catalog');

const ENV = process.env;
const IMG = 'https://image.tmdb.org/t/p/w342';
// Example default location (San Jose, CA); set WEATHER_LAT / WEATHER_LON / WEATHER_PLACE to your own.
const WEATHER = { lat: +(ENV.WEATHER_LAT || 37.3382), lon: +(ENV.WEATHER_LON || -121.8863), place: ENV.WEATHER_PLACE || 'San Jose' };

function getJSON(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'GlassHome-voice-relay' }, headers || {}) }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) { const e = new Error('HTTP ' + res.statusCode); e.status = res.statusCode; return reject(e); }
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad JSON')); }
      });
    });
    req.setTimeout(timeoutMs || 8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const hasTmdb = () => !!(ENV.TMDB_API_KEY || ENV.TMDB_READ_TOKEN);
const hasOmdb = () => !!ENV.OMDB_API_KEY;
function tmdb(path, q) {
  const key = ENV.TMDB_API_KEY || '', tok = ENV.TMDB_READ_TOKEN || (/^eyJ/.test(key) ? key : '');
  let url = 'https://api.themoviedb.org/3' + path + (path.indexOf('?') < 0 ? '?' : '&') + (q || '');
  if (!tok) url += '&api_key=' + encodeURIComponent(key);
  return getJSON(url, tok ? { Authorization: 'Bearer ' + tok } : null);
}
function omdb(imdbId) {
  return getJSON('https://www.omdbapi.com/?i=' + encodeURIComponent(imdbId) + '&apikey=' + encodeURIComponent(ENV.OMDB_API_KEY || ''));
}
function platformKey(s) {
  if (!s) return null; s = String(s).toLowerCase().trim();
  if (PLATFORMS[s]) return s;
  for (const k of Object.keys(PLATFORMS)) if (PLATFORMS[k].words.some(w => s === w || s.indexOf(w) >= 0)) return k;
  return null;
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function genreWord(genres) { return genres && genres.length ? genres[0].replace('sci-fi', 'sci-fi title').replace(/y$/, 'ie') + 's' : 'titles'; }

function usProviders(d) {
  const us = ((d['watch/providers'] || {}).results || {}).US || {};
  const flat = (us.flatrate || []).map(p => PROVIDER_TO_APP[p.provider_id]).filter(Boolean);
  return flat.filter((k, i) => flat.indexOf(k) === i);
}
function toItem(kind, r, d) {
  d = d || {};
  const title = r.title || r.name || d.title || d.name, date = r.release_date || r.first_air_date || d.release_date || d.first_air_date || '';
  const run = kind === 'movie' ? d.runtime : (d.episode_run_time || [])[0];
  const ids = (r.genre_ids || (d.genres || []).map(g => g.id));
  return { id: r.id, kind, title, year: date ? +date.slice(0, 4) : null, poster: (r.poster_path || d.poster_path) ? IMG + (r.poster_path || d.poster_path) : null,
    runtime: run || null, seasons: d.number_of_seasons || null, genres: ids.map(g => GENRE_NAMES[g]).filter(Boolean).slice(0, 2), genreAll: ids.map(g => GENRE_NAMES[g]).filter(Boolean),
    imdbId: d.imdb_id || (d.external_ids || {}).imdb_id || null, imdb: null, rt: null, tmdbVote: r.vote_average || d.vote_average || null,
    platforms: usProviders(d), platform: null, overview: (r.overview || d.overview || '').slice(0, 220) };
}
function finishItem(it, platform) {
  it.platform = platform && it.platforms.indexOf(platform) >= 0 ? platform : (it.platforms[0] || null);
  it.platformName = it.platform ? PLATFORMS[it.platform].name : null;
  return it;
}
function rank(a, b) {
  const ai = a.imdb ? parseFloat(a.imdb) : (a.tmdbVote || 0) - 0.3, bi = b.imdb ? parseFloat(b.imdb) : (b.tmdbVote || 0) - 0.3;
  return (bi - ai) || ((b.rt || 0) - (a.rt || 0));
}
async function details(kind, r) {
  return tmdb('/' + kind + '/' + r.id, 'language=en-US&append_to_response=watch/providers,external_ids').then(d => toItem(kind, r, d), () => toItem(kind, r, null));
}
async function rate(items, ctx) {
  const withId = items.filter(i => i.imdbId);
  if (!hasOmdb()) { await ctx.step('Checking IMDb & Rotten Tomatoes', async () => 'skipped · no OMDb key'); return; }
  await ctx.step('Checking IMDb & Rotten Tomatoes', async () => {
    let n = 0;
    await Promise.all(withId.map(it => omdb(it.imdbId).then(o => {
      if (o && o.imdbRating && o.imdbRating !== 'N/A') { it.imdb = o.imdbRating; n++; }
      const rt = (o.Ratings || []).filter(x => x.Source === 'Rotten Tomatoes')[0];
      if (rt) it.rt = parseInt(rt.Value, 10);
    }, () => {})));
    return 'OMDb · ' + plural(n, 'title') + ' scored';
  });
}
function needTmdb() { const e = new Error('TMDB key missing (set TMDB_API_KEY)'); e.user = 'I need a TMDB key on the relay to look up shows and movies.'; return e; }

/* search_titles: {query, person, kind: movie|tv|any, genres: [..], max_runtime, platform, sort: popular|top_rated, limit} */
async function searchTitles(a, ctx) {
  if (!hasTmdb()) throw needTmdb();
  a = a || {};
  const plat = platformKey(a.platform), genres = (a.genres || []).map(g => String(g).toLowerCase()).filter(g => GENRES[g]);
  const maxRun = a.max_runtime ? +a.max_runtime : null, limit = Math.min(+a.limit || 3, 6);
  let kinds = a.kind === 'movie' || a.kind === 'tv' ? [a.kind] : ['movie', 'tv'];
  let cands = [], total = 0, label = 'Searching TMDB', detail = '';
  await ctx.step(label, async () => {
    if (a.person) {
      const p = await tmdb('/search/person', 'query=' + encodeURIComponent(a.person));
      const who = (p.results || [])[0];
      if (!who) return 'no person named “' + a.person + '”';
      ctx.note && ctx.note({ person: who.name });
      for (const k of kinds) {
        if (k === 'movie') {
          const r = await tmdb('/discover/movie', 'with_cast=' + who.id + '&sort_by=' + (a.sort === 'top_rated' ? 'vote_average.desc&vote_count.gte=300' : 'popularity.desc') +
            (maxRun ? '&with_runtime.lte=' + maxRun : '') + (genres.length ? '&with_genres=' + genres.map(g => GENRES[g].movie).filter(Boolean).join('|') : ''));
          total += r.total_results || 0; cands = cands.concat((r.results || []).slice(0, 10).map(x => ['movie', x]));
        } else {
          const r = await tmdb('/person/' + who.id + '/tv_credits', 'language=en-US');
          const list = (r.cast || []).filter(x => (x.episode_count || 0) >= 3 && !/talk|news/i.test(x.character || '')).sort((x, y) => (y.vote_count || 0) - (x.vote_count || 0));
          total += list.length; cands = cands.concat(list.slice(0, 6).map(x => ['tv', x]));
        }
      }
      return who.name + ' · ' + plural(total, 'credit') + ' found';
    }
    if (a.query) {
      const r = await tmdb('/search/multi', 'language=en-US&include_adult=false&query=' + encodeURIComponent(a.query));
      const list = (r.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv').filter(x => kinds.indexOf(x.media_type) >= 0);
      total = list.length; cands = list.slice(0, 8).map(x => [x.media_type, x]);
      return '“' + a.query + '” · ' + plural(total, 'match', 'matches');
    }
    const provs = plat ? PLATFORMS[plat].providers : ALL_PROVIDERS;
    for (const k of kinds) {
      const gids = genres.map(g => GENRES[g][k]).filter(Boolean);
      if (genres.length && !gids.length) continue;
      const q = 'language=en-US&watch_region=US&with_watch_monetization_types=flatrate&with_watch_providers=' + provs.join('|') +
        '&with_original_language=en&sort_by=' + (a.sort === 'top_rated' ? 'vote_average.desc&vote_count.gte=' + (k === 'tv' ? 200 : 500) : 'popularity.desc&vote_count.gte=' + (k === 'tv' ? 40 : 150)) +
        (gids.length ? '&with_genres=' + gids.join('|') : '') + (maxRun ? '&with_runtime.lte=' + maxRun : '') +
        (k === 'tv' ? '&without_genres=10763,10767' : '');
      const r = await tmdb('/discover/' + k, q);
      total += r.total_results || 0; cands = cands.concat((r.results || []).slice(0, kinds.length > 1 ? 6 : 10).map(x => [k, x]));
    }
    return (plat ? PLATFORMS[plat].name : 'your services') + ' catalogue · ' + total.toLocaleString('en-US') + ' ' + genreWord(genres) + ' found';
  });
  if (!cands.length) return { items: [], total: 0, summary: 'nothing found' };
  let items = [];
  await ctx.step('Checking runtimes & where to watch', async () => {
    items = await Promise.all(cands.slice(0, 10).map(c => details(c[0], c[1])));
    const n0 = items.length;
    if (maxRun) items = items.filter(i => !i.runtime || i.runtime <= maxRun);
    if (plat) items = items.filter(i => i.platforms.indexOf(plat) >= 0);
    else if (!a.query && !a.person) items = items.filter(i => i.platforms.length);
    items.forEach(i => finishItem(i, plat));
    if (!plat && (a.query || a.person)) return plural(n0, 'title') + ' · ' + items.filter(i => i.platforms.length).length + ' on your services';
    return plural(n0, 'title') + ' → ' + items.length + (plat ? ' on ' + PLATFORMS[plat].name : maxRun ? ' under ' + fmtRun(maxRun) : ' on your services');
  });
  await rate(items, ctx);
  items.sort(rank);
  const top = items.slice(0, limit);
  return { items: top, total, considered: items.length, platform: plat, genres, maxRun };
}
function fmtRun(m) { return m % 60 === 0 ? (m / 60) + ' h' : m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'; }

/* get_ratings: {title, year, kind} */
async function getRatings(a, ctx) {
  if (!hasTmdb()) throw needTmdb();
  let it = null;
  await ctx.step('Finding the title', async () => {
    const r = await tmdb('/search/multi', 'language=en-US&include_adult=false&query=' + encodeURIComponent(a.title || ''));
    let list = (r.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv');
    if (a.kind === 'movie' || a.kind === 'tv') list = list.filter(x => x.media_type === a.kind).concat(list.filter(x => x.media_type !== a.kind));
    if (a.year) list.sort((x, y) => Math.abs(+(x.release_date || x.first_air_date || '0').slice(0, 4) - a.year) - Math.abs(+(y.release_date || y.first_air_date || '0').slice(0, 4) - a.year));
    const hit = list[0]; if (!hit) return 'no match for “' + a.title + '”';
    it = finishItem(await details(hit.media_type, hit));
    return 'TMDB · ' + it.title + (it.year ? ' (' + it.year + ')' : '') + ' · ' + plural(list.length, 'match', 'matches');
  });
  if (!it) return { items: [], found: false };
  await rate([it], ctx);
  return { items: [it], found: true };
}

/* get_weather: {day: today|tomorrow|week} — Open-Meteo, free, no key */
const WCODE = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'heavy showers', 95: 'thunderstorms', 96: 'thunderstorms', 99: 'thunderstorms' };
async function getWeather(a, ctx) {
  let out = null;
  await ctx.step('Checking the forecast', async () => {
    const w = await getJSON('https://api.open-meteo.com/v1/forecast?latitude=' + WEATHER.lat + '&longitude=' + WEATHER.lon +
      '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
      '&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles&forecast_days=7');
    const d = w.daily || {};
    const day = i => ({ date: d.time[i], high: Math.round(d.temperature_2m_max[i]), low: Math.round(d.temperature_2m_min[i]), rain: d.precipitation_probability_max[i], sky: WCODE[d.weather_code[i]] || 'mixed' });
    out = { place: WEATHER.place, now: w.current ? { temp: Math.round(w.current.temperature_2m), sky: WCODE[w.current.weather_code] || '' } : null,
      today: day(0), tomorrow: day(1), week: d.time.map((_, i) => day(i)) };
    return 'Open-Meteo · ' + WEATHER.place + ' · ' + (a && a.day === 'tomorrow' ? 'tomorrow' : 'today');
  });
  return out;
}

/* launcher_action: {action: open_app|show_platform, app} */
async function launcherAction(a, ctx) {
  const app = platformKey(a.app);
  if (!app) return { ok: false, error: 'unknown app ' + a.app };
  const action = a.action === 'show_platform' && app !== 'youtube' ? 'show_platform' : 'open_app';
  await ctx.step(action === 'open_app' ? 'Opening ' + PLATFORMS[app].name : 'Showing ' + PLATFORMS[app].name + ' in Discover', async () => { ctx.emit({ type: 'action', action, app }); return 'sent to TV'; });
  return { ok: true, action, app, name: PLATFORMS[app].name };
}
module.exports = { searchTitles, getRatings, getWeather, launcherAction, platformKey, fmtRun, getJSON, hasTmdb, hasOmdb, plural };
