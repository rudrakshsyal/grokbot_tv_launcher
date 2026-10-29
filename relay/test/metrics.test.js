// Metrics aggregation + recorder unit tests (no network). usage: node relay/test/metrics.test.js
const assert = require('assert'), os = require('os'), path = require('path'), fs = require('fs');
process.env.METRICS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-metrics-'));
const M = require('../metrics');
let pass = 0; const ok = (n, fn) => { fn(); pass++; console.log('PASS', n); };
try {
  ok('percentiles (nearest-rank)', () => { const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; assert.strictEqual(M.pct(a, 50), 5); assert.strictEqual(M.pct(a, 95), 10); assert.strictEqual(M.pct([], 50), null); });
  const now = new Date(2026, 9, 29, 12, 0, 0), yday = new Date(2026, 9, 28, 12, 0, 0);
  const recs = [
    { ts: yday.toISOString(), model: 'gemini-3.8-flash', totalMs: 9000, tokens: { prompt: 900, completion: 100, total: 1000 }, llmCalls: 2, hops: 0 },
    { ts: now.toISOString(), model: 'gemini-3.8-flash', totalMs: 4000, tokens: { prompt: 1500, completion: 300, total: 1800 }, llmCalls: 3, hops: 0 },
    { ts: now.toISOString(), model: 'built-in', totalMs: 2000, tokens: 'n/a', llmCalls: 0, hops: 1, fallback: 'gemini: rate-limited' },
    { ts: now.toISOString(), model: 'built-in', totalMs: 1000, tokens: 'n/a', llmCalls: 0, hops: 0, error: 'timeout' }
  ];
  const a = M.aggregate(recs, now);
  ok('today vs all-time split', () => { assert.strictEqual(a.today.requests, 3); assert.strictEqual(a.all.requests, 4); });
  ok('tokens only from LLM requests (parser = n/a)', () => { assert.strictEqual(a.today.tokens, 1800); assert.strictEqual(a.all.tokens, 2800); assert.strictEqual(a.all.avgTokens, 1400); assert.strictEqual(a.all.promptTokens, 2400); });
  ok('latency avg/p50/p95', () => { assert.strictEqual(a.all.avgMs, 4000); assert.strictEqual(a.all.p50Ms, 2000); assert.strictEqual(a.all.p95Ms, 9000); assert.strictEqual(a.today.p50Ms, 2000); });
  ok('fallback rate + errors + per-model counts', () => { assert.strictEqual(a.today.fallbackRate, 0.333); assert.strictEqual(a.today.errors, 1); assert.deepStrictEqual(a.all.models, { 'gemini-3.8-flash': 2, 'built-in': 2 }); });
  ok('empty log', () => { const e = M.aggregate([], now); assert.strictEqual(e.all.requests, 0); assert.strictEqual(e.all.avgMs, null); assert.strictEqual(e.last, null); });
  const m = M.begin('is dune good', { client: 'x' });
  m.step('Heard you', 1, 'ok'); m.llm('fake', 800, { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 }); m.llm('fake', 600, null);
  m.tool('get_ratings', 300, { title: 'Dune' }, { items: [{ title: 'Dune', imdb: '8.0' }] }); m.step('Finding the title', 300, 'ok');
  const st = M.stats(m, 'fake');
  ok('stats object: tokens summed, calls counted, tool ms', () => { assert.deepStrictEqual(st.tokens, { prompt: 1200, completion: 40, total: 1240 }); assert.strictEqual(st.llmCalls, 2); assert.strictEqual(st.llmMs, 1400); assert.deepStrictEqual(st.toolMs, { get_ratings: 300 }); assert.strictEqual(st.tools, 1); assert.ok(st.firstStepMs != null); });
  ok('parser stats say n/a for tokens', () => assert.strictEqual(M.stats(M.begin('x'), 'built-in').tokens, 'n/a'));
  const rec = M.record(m, st, { answer: 'ok' });
  ok('jsonl append + read back, no key-ish fields', () => { const r = M.read(); assert.strictEqual(r.length, 1); assert.strictEqual(r[0].text, 'is dune good'); assert.ok(!/key|authorization/i.test(Object.keys(rec).join(','))); });
  console.log(pass + ' metrics checks passed');
} catch (e) { console.log('FAIL', e.message); process.exitCode = 1; }
