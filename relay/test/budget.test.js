// Zero-cost guard: daily request/token caps (Pacific day, persisted + seeded from metrics.jsonl) and the billing latch.
// Fake local OpenAI-compatible server only; no network. usage: node relay/test/budget.test.js
const http = require('http'), assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
let mode = 'ok', calls = 0;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    calls++; const body = JSON.parse(b), last = body.messages[body.messages.length - 1];
    if (mode === 'billing') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"This model requires a paid tier with billing enabled"}}'); }
    if (mode === 'quota429') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}'); }
    const msg = last.role === 'tool' ? { role: 'assistant', content: 'Opening Netflix now.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'launcher_action', arguments: '{"action":"open_app","app":"netflix"}' } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
});
fake.listen(0, '127.0.0.1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  const env = { METRICS_DIR: dir, DATA_DIR: dir, CHATS_DIR: path.join(dir, 'chats'), METRICS: '0', LLM_BASE_URL: 'http://127.0.0.1:' + fake.address().port + '/v1/', LLM_API_KEY: 'test', LLM_MODEL: 'fake-model', OLLAMA_FALLBACK: '0', LOG: '0', LLM_MAX_REQUESTS_PER_DAY: '3' };
  Object.assign(process.env, env);
  const { ask } = require('../server'), LLM = require('../brain-llm');
  let pass = 0; const ok = (n, fn) => { fn(); pass++; console.log('PASS', n); };
  try {
    const a1 = await ask('open netflix', { client: 'b1' });
    ok('under the cap: LLM answers and calls are counted (2 req, 220 tok)', () => { assert.strictEqual(a1.brain, 'fake-model'); const s = LLM.budgetStatus(); assert.deepStrictEqual([s.requests, s.tokens, s.blocked], [2, 220, null]); });
    const a2 = await ask('open netflix', { client: 'b2' });
    ok('cap hit mid-request: falls back to the parser, stats say daily AI limit reached', () => { assert.strictEqual(a2.brain, 'built-in'); assert.ok(/daily AI limit reached/.test(a2.stats.fallback), a2.stats.fallback); assert.strictEqual(LLM.budgetStatus().requests, 3); });
    const before = calls; const a3 = await ask('open netflix', { client: 'b3' });
    ok('over the cap: no HTTP request is sent at all', () => { assert.strictEqual(calls, before); assert.strictEqual(a3.brain, 'built-in'); assert.strictEqual(a3.stats.hops, 1); assert.ok(/daily AI limit reached/.test(a3.stats.fallback)); });
    ok('counter persisted to llm-budget.json (mode 600, Pacific day)', () => { const f = path.join(dir, 'llm-budget.json'), j = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.strictEqual(j.requests, 3); assert.strictEqual(j.day, LLM.pacificDay()); assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600); });
    process.env.LLM_MAX_REQUESTS_PER_DAY = '1000'; process.env.LLM_MAX_TOKENS_PER_DAY = '330';
    ok('token cap also blocks (330 tokens used of 330)', () => { assert.strictEqual(LLM.budgetStatus().tokens, 330); assert.strictEqual(LLM.budgetStatus().blocked, 'daily AI limit reached'); });
    process.env.LLM_MAX_TOKENS_PER_DAY = '1000000'; mode = 'quota429';
    await ask('open netflix', { client: 'b4' });
    ok('free-tier quota 429 ("check your plan and billing details") is a rate limit, not a billing latch', () => assert.strictEqual(LLM.budgetStatus().billing, null));
    mode = 'billing'; const a5 = await ask('open netflix', { client: 'b5' });
    ok('billing / paid-tier response latches remote LLM off', () => { assert.ok(LLM.budgetStatus().billing); assert.strictEqual(a5.brain, 'built-in'); assert.strictEqual(LLM.budgetStatus().blocked, 'billing indicated \u2014 LLM off'); });
    mode = 'ok'; const c0 = calls; const a6 = await ask('open netflix', { client: 'b6' });
    ok('after the latch nothing is sent even when the provider is fine', () => { assert.strictEqual(calls, c0); assert.strictEqual(a6.brain, 'built-in'); });
    // fresh process: stale day in the file -> reset and reseed from today's metrics.jsonl; billing latch survives
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'budget2-'));
    fs.writeFileSync(path.join(d2, 'llm-budget.json'), JSON.stringify({ day: '2000-01-01', requests: 999, tokens: 999999, billing: null }));
    fs.writeFileSync(path.join(d2, 'metrics.jsonl'), [{ ts: new Date().toISOString(), brain: 'llm', llmCalls: 2, tokens: { total: 500 } }, { ts: '2000-01-01T12:00:00Z', brain: 'llm', llmCalls: 9, tokens: { total: 9 } }, { ts: new Date().toISOString(), brain: 'free', llmCalls: 0, tokens: 'n/a' }].map(JSON.stringify).join('\n') + '\n');
    const out = JSON.parse(cp.execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(' + JSON.stringify(path.join(__dirname, '..', 'brain-llm')) + ').budgetStatus()))'], { env: Object.assign({}, process.env, { METRICS_DIR: d2, LLM_MAX_REQUESTS_PER_DAY: '', LLM_MAX_TOKENS_PER_DAY: '' }) }).toString());
    ok('new Pacific day resets; seeded from today\u2019s metrics.jsonl; defaults 200 req / 200k tokens', () => assert.deepStrictEqual([out.requests, out.tokens, out.maxRequests, out.maxTokens, out.blocked], [2, 500, 200, 200000, null]));
    console.log(pass + ' budget checks passed'); fake.close(); process.exit(0);
  } catch (e) { console.log('FAIL', e.stack || e.message); process.exit(1); }
});
