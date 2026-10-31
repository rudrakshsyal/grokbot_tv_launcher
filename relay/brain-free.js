'use strict';
// Zero-cost brain: rule-based parser + real tools, templated short answers.
const { parse, describe, fmtRun } = require('./parser');
const T = require('./tools'), M = require('./metrics');
const { PLATFORMS } = require('./catalog');
const HELP = 'I can help with shows, movies, ratings, weather, opening apps and playing things on the TV.';
let PLAY = null;   // set by server.js
function setPlayer(fn) { PLAY = fn; }

function list(names) { return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]; }
function score(i) { return [i.imdb ? 'IMDb ' + i.imdb : null, i.rt != null ? i.rt + '% on Rotten Tomatoes' : null].filter(Boolean).join(' and '); }
function verdict(i) {
  const s = i.imdb ? parseFloat(i.imdb) : null;
  if (s == null) return '';
  return s >= 7.5 ? 'Yes, people really like it. ' : s >= 6.5 ? "It's pretty good. " : s >= 5.5 ? 'Reviews are mixed. ' : 'Most people didn\'t love it. ';
}
const GW = { comedy: 'comedies', horror: 'horror picks', action: 'action picks', 'sci-fi': 'sci-fi picks', romance: 'romantic picks', thriller: 'thrillers', documentary: 'documentaries', drama: 'dramas', family: 'feel-good picks', animation: 'animated picks', mystery: 'mysteries', crime: 'crime picks', fantasy: 'fantasy picks' };

async function run(text, ctx) {
  const p = parse(text);
  await ctx.step('Understood', async () => describe(p));
  if (p.intent === 'unknown') return { text: HELP, items: [] };
  if (p.intent === 'play') {
    if (!PLAY) return { text: 'Playing on the TV isn\'t set up on the relay.', items: [] };
    const a = { query: p.query, service: p.service, kind: p.playKind, different: p.different }, r = await M.timeTool(ctx, 'play_on_tv', a, () => PLAY(a, ctx));
    return { text: (r && r.say) || 'Done.', items: [], played: r };
  }
  if (p.intent === 'weather') {
    const w = await M.timeTool(ctx, 'get_weather', { day: p.day }, () => T.getWeather({ day: p.day }, ctx));
    if (p.day === 'week') return { text: 'This week in ' + w.place + ': highs from ' + Math.min.apply(null, w.week.map(d => d.high)) + ' to ' + Math.max.apply(null, w.week.map(d => d.high)) + ' degrees, ' + w.week.filter(d => d.rain >= 40).length + ' days likely to rain.', items: [], weather: w };
    const d = w[p.day];
    return { text: (p.day === 'today' ? 'Today' : 'Tomorrow') + ' in ' + w.place + ': ' + d.sky + ', high ' + d.high + ', low ' + d.low + (d.rain != null ? ', ' + d.rain + '% chance of rain' : '') + '.' + (p.day === 'today' && w.now ? ' It\'s ' + w.now.temp + ' now.' : ''), items: [], weather: w };
  }
  if (p.intent === 'open' || p.intent === 'show_platform') {
    const la = { action: p.intent === 'open' ? 'open_app' : 'show_platform', app: p.platform }, r = await M.timeTool(ctx, 'launcher_action', la, () => T.launcherAction(la, ctx));
    return { text: (r.action === 'open_app' ? 'Opening ' : 'Here\'s ') + r.name + '.', items: [] };
  }
  if (p.intent === 'ratings') {
    const r = await M.timeTool(ctx, 'get_ratings', { title: p.title }, () => T.getRatings({ title: p.title }, ctx));
    if (!r.found) return { text: 'I couldn\'t find "' + p.title + '".', items: [] };
    const i = r.items[0], s = score(i);
    return { text: verdict(i) + i.title + (i.year ? ' (' + i.year + ')' : '') + (s ? ' has ' + s + '.' : ' has no ratings yet.') + (i.platformName ? ' It\'s on ' + i.platformName + '.' : ''), items: r.items };
  }
  const sa = { person: p.person, kind: p.kind, genres: p.genres, max_runtime: p.maxRun, platform: p.platform, sort: p.sort, limit: 3 }, r = await M.timeTool(ctx, 'search_titles', sa, () => T.searchTitles(sa, ctx));
  if (!r.items.length) return { text: 'I couldn\'t find anything that fits' + (p.platform ? ' on ' + PLATFORMS[p.platform].name : '') + '. Try loosening it a bit?', items: [] };
  const top = r.items[0];
  let lead;
  if (p.intent === 'person') lead = 'Top ' + p.person + ' picks: ' + list(r.items.map(i => i.title)) + '.';
  else lead = 'Here are ' + r.items.length + ' ' + (GW[p.genres[0]] || (p.kind === 'movie' ? 'movies' : p.kind === 'tv' ? 'shows' : 'picks')) +
    (p.maxRun ? ' under ' + fmtRun(p.maxRun) : '') + (p.platform ? ' on ' + PLATFORMS[p.platform].name : '') + '.';
  return { text: lead + ' Top pick: ' + top.title + (top.year ? ' (' + top.year + ')' : '') + (top.imdb ? ', IMDb ' + top.imdb : '') + (top.platformName && !p.platform ? ', on ' + top.platformName : '') + '.', items: r.items };
}
module.exports = { run, HELP, setPlayer };
