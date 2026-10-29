'use strict';
// Free, rule-based intent parser (no LLM). Used as the default when no LLM key is set, and as the automatic fallback.
const { PLATFORMS, MOODS } = require('./catalog');

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, half: 0.5 };
function findPlatform(t) {
  let best = null, at = -1;
  Object.keys(PLATFORMS).forEach(k => PLATFORMS[k].words.forEach(w => {
    const m = new RegExp('(^|[^a-z])' + w.replace(/[+]/g, '\\+') + '($|[^a-z])').exec(t);
    if (m && (!best || w.length > best[1].length)) { best = [k, w]; at = m.index; }
  }));
  if (best && best[1] === 'max' && !/\b(on|in|from|open|launch|start|watch|hbo)\s+(hbo\s+)?max\b/.test(t)) return null;   // "max" alone is ambiguous
  if (best && best[1] === 'apple' && !/\bapple\b.*\b(tv|on|open|launch)\b|\b(on|open|launch|start)\s+apple\b/.test(t)) return null;
  return best ? best[0] : null;
}
function runtime(t) {
  let m = /\b(under|less than|shorter than|no (?:longer|more) than|max(?:imum)?|within|at most|below)\s+(an?|one|two|three|half an?|\d+(?:\.\d+)?)\s*(?:and a half\s+)?(hours?|hrs?|h|minutes?|mins?|m)\b/.exec(t);
  if (m) {
    let n = NUM[m[2].split(' ')[0]] !== undefined ? NUM[m[2].split(' ')[0]] : parseFloat(m[2]);
    if (/and a half/.test(t.slice(m.index, m.index + m[0].length + 12))) n += 0.5;
    return Math.round(/^h/.test(m[3]) ? n * 60 : n);
  }
  m = /\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\s+(or less|max|tops)\b/.exec(t);
  if (m) return Math.round(/^h/.test(m[2]) ? parseFloat(m[1]) * 60 : parseFloat(m[1]));
  if (/\b(short|quick)\b/.test(t)) return /\b(show|series|episode)s?\b/.test(t) ? 30 : 100;
  return null;
}
function kindOf(t) {
  const mv = /\b(movies?|films?|flicks?)\b/.test(t), tv = /\b(shows?|series|tv shows?|sitcoms?|episodes?|docuseries|seasons?)\b/.test(t);
  return mv && !tv ? 'movie' : tv && !mv ? 'tv' : 'any';
}
function genresOf(t) { const g = []; MOODS.forEach(m => { if (m[0].test(t)) m[1].forEach(x => { if (g.indexOf(x) < 0) g.push(x); }); }); return g; }
function clean(s) { return s.replace(/^(the movie|the show|the film|the series)\s+/, '').replace(/[?.!,]+$/, '').trim(); }
function titleCase(s) { return s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase()); }

function parse(text) {
  const raw = String(text || '').trim(), t = raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  const out = { text: raw, intent: 'unknown', kind: kindOf(t), genres: genresOf(t), maxRun: runtime(t), platform: findPlatform(t), sort: 'popular' };
  if (/\b(best|top[- ]rated|highest[- ]rated|acclaimed|greatest|good)\b/.test(t)) out.sort = 'top_rated';
  if (/\b(trending|popular|new|everyone'?s watching|hot right now)\b/.test(t)) out.sort = 'popular';
  if (out.kind === 'any' && (/\bshort\b/.test(t) || out.maxRun >= 60)) out.kind = 'movie';   // "under 2 hours" = a movie
  out.genres = out.genres.filter(g => !(g === 'family' && /\bfamily\b/.test(t) && /\b(with|for) (the|my) family\b/.test(t) && out.genres.length > 1));

  // weather
  if (/\b(weather|forecast|temperature|rain(ing|y)?|umbrella|jacket|sunny|cold|hot|degrees)\b/.test(t) && !/\b(movies?|shows?)\b/.test(t)) {
    out.intent = 'weather'; out.day = /\btomorrow\b/.test(t) ? 'tomorrow' : /\b(week|weekend)\b/.test(t) ? 'week' : 'today'; return out;
  }
  // launcher actions
  let m = /^(?:please |hey |ok )?(?:can you |could you )?(open|launch|start|go to|switch to|put on|fire up)\s+(.+?)(?:\s+(?:app|please))?$/.exec(t);
  if (m && out.platform) { out.intent = 'open'; return out; }
  if (out.platform && /^(?:show|browse)\s+(?:me\s+)?(?:the\s+)?([a-z+ ]+?)(?:\s+(?:page|in discover|discover))?$/.test(t)) { out.intent = 'show_platform'; return out; }
  // ratings / is X good
  const tr = t.replace(/\s+(?:on|at|according to)\s+(?:imdb|rotten tomatoes)$/, '');   // "what's the office rated on imdb"
  m = /^(?:is|was|are)\s+(.+?)\s+(?:any\s+)?(good|worth (?:it|watching)|any good|ok|decent|bad)\b/.exec(tr) ||
      /^(?:how good is|how is|what(?:'s| is| are) the ratings? (?:for|of|on)|ratings? (?:for|of)|what(?:'s| is) (.+?) rated|should i watch)\s+(.+?)$/.exec(tr) ||
      /^what(?:'s| is)\s+(.+?)\s+rated\b/.exec(tr) ||
      /^(?:what do people think of|reviews? (?:for|of))\s+(.+)$/.exec(t);
  if (m) {
    const title = clean(m[1] && !/^(good|worth|any|ok|decent|bad)/.test(m[1]) && m.length > 2 && m[2] && /good|worth|ok|decent|bad/.test(m[2]) ? m[1] : (m[2] || m[1]));
    if (title && !/^(something|anything|it|this|that)$/.test(title)) { out.intent = 'ratings'; out.title = titleCase(title); return out; }
  }
  // people: "tom hanks movies", "movies with tom hanks", "anything starring zendaya"
  m = /^what (?:has|have|is|was)\s+([a-z][a-z.'-]+(?:\s+[a-z][a-z.'-]+){0,2}?)\s+(?:been in|starred in|acted in|in|done)$/.exec(t);
  if (m && !/^(there|on|good|new)\b/.test(m[1])) { out.intent = 'person'; out.person = titleCase(m[1]); return out; }
  m = /\b(?:with|starring|featuring|by|directed by)\s+([a-z][a-z.'-]+(?:\s+[a-z][a-z.'-]+){1,2})\b/.exec(t) ||
      /^(?:show me |find |any |good |best |some )*([a-z][a-z.'-]+(?:\s+[a-z][a-z.'-]+){1,2})\s+(?:movies|films|shows|series)\b/.exec(t);
  if (m) {
    const name = m[1].replace(/\s+(on|tonight|under|that|from)\b.*$/, '');
    const STOP = /\b(funny|scary|good|best|new|top|short|feel|action|comedy|horror|family|kids|romantic|netflix|hulu|prime|disney|peacock|apple|hbo|some|any|the|my|me|tonight|popular|trending|me|a|of|tv|sci|fi|crime|true|war|drama|animated|documentary|christmas|halloween|recent|old|classic)\b/;
    if (!STOP.test(name) && name.split(' ').length >= 2) { out.intent = 'person'; out.person = titleCase(name); return out; }
  }
  // recommendations / what's on
  if (out.genres.length || out.maxRun || out.kind !== 'any' ||
      /\b(watch|recommend|suggest|something|anything|tonight|what'?s (good|on|new|trending|popular)|trending|popular|pick|ideas?|bored)\b/.test(t)) {
    out.intent = 'recommend'; return out;
  }
  if (out.platform) { out.intent = 'recommend'; return out; }
  return out;
}
const fmtRun = m => m % 60 === 0 ? (m / 60) + ' h' : m > 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min';
function describe(p) {   // the "Understood" step detail
  const bits = [];
  if (p.intent === 'weather') return 'weather · ' + p.day;
  if (p.intent === 'open') return 'open app · ' + PLATFORMS[p.platform].name;
  if (p.intent === 'show_platform') return 'show in Discover · ' + PLATFORMS[p.platform].name;
  if (p.intent === 'ratings') return 'ratings · “' + p.title + '”';
  if (p.intent === 'person') bits.push('person: ' + p.person);
  if (p.genres.length) bits.push('genre: ' + p.genres.join(' / '));
  if (p.kind !== 'any') bits.push(p.kind === 'movie' ? 'movies' : 'shows');
  if (p.maxRun) bits.push('runtime < ' + p.maxRun + ' min');
  if (p.platform) bits.push('service: ' + PLATFORMS[p.platform].name + ' (US)');
  if (p.intent === 'recommend' && !bits.length) bits.push(p.sort === 'top_rated' ? 'top rated' : 'popular right now', 'your services');
  return bits.join(' · ') || 'not sure';
}
module.exports = { parse, describe, fmtRun };
