#!/usr/bin/env node
'use strict';
// Eval runner for the voice relay. Runs cases.json through the real ask() pipeline (real tools, real model) in-process,
// applies deterministic checks, optionally an LLM-as-judge score (same configured model; --no-judge skips it to save quota),
// and writes reports/<timestamp>.json + reports/latest.html.
// usage: node relay/evals/run.js [--brain gemini|groq|ollama|free] [--cases <tag|category|id>] [--no-judge] [--delay ms]
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !/^--/.test(argv[i + 1]) ? argv[i + 1] : d; };
const BRAIN = arg('--brain', 'gemini').toLowerCase(), FILTER = arg('--cases', ''), JUDGE = argv.indexOf('--no-judge') < 0 && BRAIN !== 'free';
if (BRAIN === 'free') process.env.BRAIN = 'free'; else { process.env.BRAIN_PRESET = BRAIN; delete process.env.BRAIN; }
Object.assign(process.env, { OLLAMA_FALLBACK: process.env.OLLAMA_FALLBACK || (BRAIN === 'ollama' ? '1' : '0'), LOG: '0', METRICS: process.env.EVAL_METRICS === '1' ? '1' : '0' });
const DELAY = +arg('--delay', BRAIN === 'free' ? 0 : 2500);
const { ask } = require('../server'), LLM = require('../brain-llm'), M = require('../metrics');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const REPORTS = path.join(__dirname, 'reports');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const norm = s => String(s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---- deterministic checks -------------------------------------------------------------------------------------------
// titles the answer presents as titles: "<Title> (2021)", "<Title>, IMDb 7.1", "<Title> has/with/at/rated ... IMDb", "Top pick: <Title>"
const STOP = /^(it|this|that|the|a|an|top|here|yes|no|i|you|and|also|or|try|on|its|they|he|she|which|with|both|my)$/i;
function claimedTitles(ans) {
  const out = [], T = "((?:[A-Z0-9][\\w'&:.!\\-]*)(?:\\s+(?:of|the|and|a|an|in|on|to|for|with|at|&|[A-Z0-9][\\w'&:.!\\-]*))*)";
  const res = [new RegExp(T + '\\s*\\((?:19|20)\\d\\d\\)', 'g'), new RegExp(T + ',?\\s+(?:which\\s+)?(?:has|with|at|is rated|rated|scores?|holds)?\\s*(?:an?\\s+)?(?:solid\\s+|strong\\s+|impressive\\s+|excellent\\s+)?IMDb', 'g'), new RegExp('(?:Top pick|try|check out|watch)[:\\s]+' + T, 'g')];
  res.forEach(re => { let m; while ((m = re.exec(ans))) {
    let t = m[1].replace(/^(The top pick is|Top pick is|I recommend|I'd recommend|How about|Try|Check out|Watch)\s+/i, '').replace(/(\s+(?:on|at|with|and|the|a|an|of|in|to|for|&))+$/i, '').replace(/[.,:]+$/, '').trim();
    if (t && !STOP.test(t) && t.length > 1 && /[A-Z]/.test(t) && !/^\d+(\.\d+)?\b/.test(t)) out.push(t); } });
  return out.filter((t, i) => out.indexOf(t) === i);
}
const NOT_TITLES = /^(imdb|rotten tomatoes|netflix|hulu|hbo max|max|prime video|apple tv\+?|peacock|disney\+?|youtube|san jose|it's|its|on|and)$/i;
function check(c, r, known) {
  const e = Object.assign({}, SPEC.defaults, c.expect || {}), out = [], add = (name, pass, why) => out.push({ name, pass: !!pass, why: pass ? '' : why });
  const m = r.metrics || { tools: [], actions: [] }, toolNames = m.tools.map(t => t.name), items = r.items || [], ans = r.text || '';
  add('answered', ans.trim().length > 0 && !r.error, r.error ? 'error: ' + r.error : 'empty answer');
  if (e.maxWords) add('short (\u2264' + e.maxWords + ' words)', words(ans) <= e.maxWords, words(ans) + ' words');
  if (e.latencyMs) add('latency \u2264 ' + (e.latencyMs / 1000) + ' s', r.stats && r.stats.totalMs <= e.latencyMs, 'took ' + ((r.stats || {}).totalMs / 1000).toFixed(1) + ' s');
  if (e.tools) add('tool: ' + e.tools.join(' | '), e.tools.some(t => toolNames.indexOf(t) >= 0), 'called ' + (toolNames.join(', ') || 'no tools'));
  if (e.noTools) add('no tools needed', !toolNames.length, 'called ' + toolNames.join(', '));
  if (e.toolArg) Object.keys(e.toolArg).forEach(k => add('tool arg ' + k + '~' + e.toolArg[k], m.tools.some(t => norm(t.args[k]).indexOf(norm(e.toolArg[k])) >= 0), 'args: ' + JSON.stringify(m.tools.map(t => t.args)).slice(0, 120)));
  if (e.action) add('TV action ' + e.action.action + ' ' + e.action.app, m.actions.some(a => a.action === e.action.action && a.app === e.action.app), 'actions: ' + (JSON.stringify(m.actions) || '[]'));
  if (e.noAction) add('no TV action', !m.actions.length, 'sent ' + JSON.stringify(m.actions));
  if (e.answerMatches) add('answer ~ /' + e.answerMatches + '/', new RegExp(e.answerMatches, 'i').test(ans), '"' + ans.slice(0, 80) + '"');
  const I = e.items;
  if (I) {
    // constraint checks use the tool result rows (full genre list, all platforms) matched by title
    const rows = items.map(it => known.rows.filter(x => x.title === it.title)[0] || { title: it.title, runtime: it.runtime, kind: it.kind, platforms: it.platform ? [it.platform] : [], genres: it.genres || [], imdb: it.imdb });
    if (I.min != null) add('\u2265' + I.min + ' item(s)', items.length >= I.min, items.length + ' items');
    if (I.max != null) add('\u2264' + I.max + ' items', items.length <= I.max, items.length + ' items: ' + items.map(i => i.title).join(', '));
    if (I.maxRuntime) { const bad = rows.filter(x => x.kind !== 'tv' && x.runtime && x.runtime > I.maxRuntime); add('runtime \u2264 ' + I.maxRuntime + ' min', rows.length && !bad.length, bad.map(x => x.title + ' ' + x.runtime + 'm').join(', ') || 'no items'); }
    if (I.platform) { const bad = rows.filter(x => (x.platforms || []).indexOf(I.platform) < 0); add('on ' + I.platform, rows.length && !bad.length, bad.map(x => x.title + ' [' + (x.platforms || []).join('/') + ']').join(', ') || 'no items'); }
    if (I.genre) { const g = I.genre.toLowerCase(), bad = rows.filter(x => !(x.genres || []).some(y => y.toLowerCase().indexOf(g) >= 0)); add('genre ' + I.genre, rows.length && !bad.length, bad.map(x => x.title + ' [' + (x.genres || []).join('/') + ']').join(', ') || 'no items'); }
    if (I.kind) { const bad = rows.filter(x => x.kind !== I.kind); add('kind ' + I.kind, rows.length && !bad.length, bad.map(x => x.title + ' (' + x.kind + ')').join(', ') || 'no items'); }
    if (I.titleIncludes) add('found "' + I.titleIncludes + '"', items.some(x => norm(x.title).indexOf(norm(I.titleIncludes)) >= 0), items.map(i => i.title).join(', ') || 'no items');
  }
  if (e.ratings) {
    const bad = items.filter(i => i.imdb != null && !/^\d{1,2}\.\d$/.test(String(i.imdb)));
    add('real IMDb ratings', items.some(i => i.imdb) && !bad.length, bad.length ? 'malformed: ' + bad.map(i => i.imdb).join(',') : 'no item has an IMDb rating');
  }
  if (e.noHallucination) {
    const kt = known.titles.map(norm), claims = claimedTitles(ans).filter(t => !NOT_TITLES.test(t));
    const ghost = claims.filter(t => { const n = norm(t); return n && !kt.some(k => k === n || k.indexOf(n) >= 0 || (n.indexOf(k) >= 0 && k.length > 3)); });
    const nums = (ans.match(/IMDb(?: rating| score)?(?: of| is)?:?\s*(\d{1,2}\.\d)|(\d{1,2}\.\d)(?:\/10| out of 10)?\s+(?:on|from|at)\s+IMDb/gi) || []).map(s => s.match(/\d{1,2}\.\d/)[0]);
    const ghostNum = nums.filter(n => known.ratings.indexOf(n) < 0);
    add('no hallucinated titles/ratings', !ghost.length && !ghostNum.length, (ghost.length ? 'titles not in tool results: ' + ghost.join(', ') : '') + (ghostNum.length ? ' ratings not in results: ' + ghostNum.join(', ') : ''));
  }
  return out;
}

// ---- optional LLM-as-judge (1 small call per case, no tools) ---------------------------------------------------------
async function judge(c, r) {
  const ep = LLM.endpoints()[0]; if (!ep) return null;
  const body = { model: ep.model, max_tokens: 200, messages: [
    { role: 'system', content: 'You grade a TV voice assistant. Score 1-5: 5 = directly answers, short and spoken-friendly, consistent with the shown items, no invented facts; 1 = wrong/unhelpful. Reply ONLY JSON: {"score":n,"why":"<12 words"}' },
    { role: 'user', content: 'User: ' + c.q + '\nAssistant: ' + (r.text || r.error) + '\nItems shown: ' + JSON.stringify((r.items || []).map(i => ({ t: i.title, y: i.year, imdb: i.imdb, on: i.platformName, min: i.runtime }))) }] };
  if (ep.reasoning) body.reasoning_effort = ep.reasoning;
  try {
    const t = Date.now(), x = await LLM.post(ep, body);
    const txt = ((x.choices || [])[0] || {}).message && x.choices[0].message.content || '';
    const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    return { score: +j.score || null, why: String(j.why || '').slice(0, 90), tokens: (x.usage || {}).total_tokens || null, ms: Date.now() - t };
  } catch (e) { return { score: null, why: 'judge skipped: ' + M.reason(e), tokens: null }; }
}

// ---- run -----------------------------------------------------------------------------------------------------------
(async () => {
  let cases = SPEC.cases;
  if (FILTER) cases = cases.filter(c => c.id === FILTER || c.category === FILTER || (c.tags || []).indexOf(FILTER) >= 0);
  const brainName = BRAIN === 'free' ? 'built-in parser' : (LLM.endpoints()[0] || {}).model || BRAIN;
  console.log('Evals \u00b7 brain ' + brainName + ' \u00b7 ' + cases.length + ' cases \u00b7 judge ' + (JUDGE ? 'on' : 'off') + '\n');
  const rows = [], runId = Date.now();
  for (const c of cases) {
    const client = 'eval-' + runId + '-' + (c.session || c.id), known = { titles: [], ratings: [], rows: [] }, extraTok = { t: 0 };
    const learn = res => { if (!res || !res.metrics) return; res.metrics.tools.forEach(t => t.items.forEach(i => { known.titles.push(i.title); if (i.imdb) known.ratings.push(String(i.imdb)); known.rows.push(i); })); };
    for (const s of c.setup || []) { const sr = await ask(s, { client, typed: true }); learn(sr); if (sr && sr.stats && sr.stats.tokens.total) extraTok.t += sr.stats.tokens.total; if (DELAY) await sleep(DELAY); }
    let r = await ask(c.q, { client, typed: true }) || { error: 'no result', metrics: null };
    learn(r);
    (r.items || []).forEach(i => { known.titles.push(i.title); if (i.imdb) known.ratings.push(String(i.imdb)); });
    const checks = check(c, r, known), failed = checks.filter(x => !x.pass);
    const j = JUDGE ? await judge(c, r) : null;
    const st = r.stats || {};
    const row = { id: c.id, category: c.category, q: c.q, setup: c.setup || [], answer: r.text || r.error || '', items: (r.items || []).map(i => ({ title: i.title, year: i.year, imdb: i.imdb, platform: i.platformName, runtime: i.runtime })),
      pass: !failed.length, checks, failures: failed.map(x => x.name + (x.why ? ' \u2014 ' + x.why : '')), model: st.model, totalMs: st.totalMs, firstStepMs: st.firstStepMs, llmMs: st.llmMs,
      llmCalls: st.llmCalls, tokens: st.tokens, setupTokens: extraTok.t, tools: (r.metrics ? r.metrics.tools : []).map(t => ({ name: t.name, ms: t.ms, args: t.args })), known: { titles: known.titles.filter((x, i, a) => a.indexOf(x) === i), ratings: known.ratings }, fallback: st.fallback, judge: j };
    rows.push(row);
    const tk = st.tokens && st.tokens.total != null ? st.tokens.total : 'n/a';
    console.log((row.pass ? '\u2713 PASS' : '\u2717 FAIL') + '  ' + c.id.padEnd(24) + ((st.totalMs / 1000).toFixed(1) + 's').padStart(7) + String(tk).padStart(7) + ' tok  ' + (st.model || '').padEnd(18) + (j && j.score ? ' judge ' + j.score + '/5' : '') + (failed.length ? '\n          ' + row.failures.join('\n          ') : ''));
    if (DELAY) await sleep(DELAY);
  }
  const rep = summarize(rows, brainName);
  fs.mkdirSync(REPORTS, { recursive: true });
  const stamp = new Date(runId).toISOString().replace(/[:.]/g, '-').slice(0, 19), file = path.join(REPORTS, stamp + '-' + BRAIN + '.json');
  fs.writeFileSync(file, JSON.stringify(rep, null, 2));
  const html = require('./report').render(rep, history());
  fs.writeFileSync(path.join(REPORTS, 'latest.html'), html); fs.writeFileSync(path.join(REPORTS, 'latest-' + BRAIN + '.html'), html);
  const S = rep.summary;
  console.log('\n' + S.passed + '/' + S.total + ' passed (' + Math.round(S.passRate * 100) + '%) \u00b7 p50 ' + (S.p50Ms / 1000).toFixed(1) + 's \u00b7 p95 ' + (S.p95Ms / 1000).toFixed(1) + 's \u00b7 avg tokens ' + (S.avgTokens == null ? 'n/a' : S.avgTokens) + ' \u00b7 fallbacks ' + S.fallbacks + (S.judgeAvg ? ' \u00b7 judge ' + S.judgeAvg + '/5' : ''));
  Object.keys(S.categories).forEach(k => console.log('  ' + k.padEnd(16) + S.categories[k].passed + '/' + S.categories[k].total));
  console.log('\nreport: ' + file + '\n        ' + path.join(REPORTS, 'latest.html'));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

function summarize(rows, brainName) {
  const ms = rows.map(r => r.totalMs).filter(x => x != null).sort((a, b) => a - b), tok = rows.filter(r => r.tokens && typeof r.tokens === 'object');
  const cats = {}; rows.forEach(r => { const c = cats[r.category] = cats[r.category] || { total: 0, passed: 0 }; c.total++; if (r.pass) c.passed++; });
  const js = rows.map(r => r.judge && r.judge.score).filter(Boolean);
  const sum = tok.reduce((a, r) => a + r.tokens.total, 0);
  return { brain: BRAIN, model: brainName, at: new Date().toISOString(), judge: JUDGE, filter: FILTER || null,
    summary: { total: rows.length, passed: rows.filter(r => r.pass).length, passRate: rows.length ? rows.filter(r => r.pass).length / rows.length : 0,
      p50Ms: M.pct(ms, 50), p95Ms: M.pct(ms, 95), avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      avgTokens: tok.length ? Math.round(sum / tok.length) : null, totalTokens: sum + rows.reduce((a, r) => a + (r.setupTokens || 0), 0) + rows.reduce((a, r) => a + (r.judge && r.judge.tokens || 0), 0),
      llmCalls: rows.reduce((a, r) => a + (r.llmCalls || 0), 0), fallbacks: rows.filter(r => r.fallback).length,
      judgeAvg: js.length ? +(js.reduce((a, b) => a + b, 0) / js.length).toFixed(2) : null, categories: cats },
    cases: rows };
}
function history() {
  try { return fs.readdirSync(REPORTS).filter(f => /\.json$/.test(f)).sort().slice(-6).map(f => { const r = JSON.parse(fs.readFileSync(path.join(REPORTS, f), 'utf8')); return { file: f, brain: r.brain, model: r.model, at: r.at, passRate: r.summary.passRate, p50Ms: r.summary.p50Ms, avgTokens: r.summary.avgTokens, total: r.summary.total }; }); }
  catch (e) { return []; }
}
