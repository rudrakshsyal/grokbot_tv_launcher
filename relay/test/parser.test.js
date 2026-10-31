// node relay/test/parser.test.js — rule-based parser examples (no network)
const assert = require('assert'), { parse } = require('../parser');
const cases = [
  ['Something funny under 2 hours on Netflix tonight', { intent: 'recommend', genres: ['comedy'], maxRun: 120, platform: 'netflix' }],
  ["What's trending on Hulu", { intent: 'recommend', platform: 'hulu', sort: 'popular' }],
  ['scary movie for tonight', { intent: 'recommend', genres: ['horror'], kind: 'movie' }],
  ['a feel-good show', { intent: 'recommend', kind: 'tv', genres: ['comedy', 'family'] }],
  ['Tom Hanks movies', { intent: 'person', person: 'Tom Hanks', kind: 'movie' }],
  ['movies with Zendaya Coleman on Prime', { intent: 'person', person: 'Zendaya Coleman', platform: 'prime' }],
  ['is Dune good', { intent: 'ratings', title: 'Dune' }],
  ['how good is The Bear', { intent: 'ratings', title: 'The Bear' }],
  ['what is Severance rated', { intent: 'ratings', title: 'Severance' }],
  ["what's the weather tomorrow", { intent: 'weather', day: 'tomorrow' }],
  ['do I need an umbrella today', { intent: 'weather', day: 'today' }],
  ['open Netflix', { intent: 'open', platform: 'netflix' }],
  ['launch disney plus', { intent: 'open', platform: 'disney' }],
  ['put on YouTube', { intent: 'open', platform: 'youtube' }],
  ['show me HBO Max', { intent: 'show_platform', platform: 'hbomax' }],
  ['a short action movie under 90 minutes', { intent: 'recommend', genres: ['action'], maxRun: 90, kind: 'movie' }],
  ['best sci-fi shows on Apple TV', { intent: 'recommend', genres: ['sci-fi'], kind: 'tv', platform: 'appletv', sort: 'top_rated' }],
  ['romantic movie under an hour and a half', { intent: 'recommend', genres: ['romance'], maxRun: 90 }],
  ['what is the capital of France', { intent: 'unknown' }],
  ['tell me a joke', { intent: 'unknown' }],
  ['play some other RÜFÜS DU SOL song on youtube', { intent: 'play', service: 'youtube', playKind: 'music', different: true }],
  ['play Breaking Bad on Netflix', { intent: 'play', query: 'breaking bad', service: 'netflix', playKind: 'title' }],
  ['stream dune on max', { intent: 'play', query: 'dune', service: 'hbomax' }],
  ['play the office on some streaming service', { intent: 'play', query: 'the office', service: 'any' }],
  ['start playing lofi hip hop on youtube', { intent: 'play', query: 'lofi hip hop', service: 'youtube' }]
];
let fails = 0;
cases.forEach(([text, want]) => {
  const got = parse(text), bad = Object.keys(want).filter(k => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
  if (bad.length) { fails++; console.log('FAIL', JSON.stringify(text), bad.map(k => k + '=' + JSON.stringify(got[k]) + ' (want ' + JSON.stringify(want[k]) + ')').join(', ')); }
  else console.log('PASS', JSON.stringify(text), '->', got.intent);
});
console.log(cases.length - fails + '/' + cases.length + ' parser cases passed'); process.exit(fails ? 1 : 0);
