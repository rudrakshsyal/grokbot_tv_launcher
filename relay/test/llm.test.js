// LLM client test against a fake local OpenAI-compatible server (no key, no network for the model).
// Checks: tool call -> tool step -> final answer, per-session memory, raw assistant message kept, 429 -> built-in fallback.
// usage: node relay/test/llm.test.js
const http = require('http'), assert = require('assert');
const seen = []; let mode = 'ok';
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const body = JSON.parse(b); seen.push(body);
    if (mode === '429') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"rate limited"}}'); }
    const last = body.messages[body.messages.length - 1];
    const msg = last.role === 'tool' ? { role: 'assistant', content: 'Opening **Netflix** now.' }
      : mode === 'play' ? { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'play_on_tv', arguments: '{"query":"RÜFÜS DU SOL","service":"youtube","kind":"music","different":true}' } }] }
      : { role: 'assistant', content: null, extra_content: { google: { thought_signature: 'sig' } }, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'launcher_action', arguments: '{"action":"open_app","app":"netflix"}' } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
});
fake.listen(0, '127.0.0.1', async () => {
  Object.assign(process.env, { DATA_DIR: require('fs').mkdtempSync(require('os').tmpdir() + '/gh-data-'), CHATS_DIR: require('fs').mkdtempSync(require('os').tmpdir() + '/gh-chats-'), METRICS_DIR: require('fs').mkdtempSync(require('os').tmpdir() + '/llmt-'), METRICS: '0', LLM_BASE_URL: 'http://127.0.0.1:' + fake.address().port + '/v1/', LLM_API_KEY: 'test', LLM_MODEL: 'fake-model', OLLAMA_FALLBACK: '0', LOG: '0' });
  const { ask } = require('../server'), LLM = require('../brain-llm');
  let pass = 0;
  const ok = (name, fn) => { fn(); pass++; console.log('PASS', name); };
  try {
    ok('endpoint from env', () => assert.deepStrictEqual(LLM.endpoints().map(e => e.model), ['fake-model']));
    const steps = [], evs = [];
    const ctx = { emit: e => evs.push(e), step: async (label, fn) => { const d = await fn(); steps.push(label + ' | ' + d); return d; } };
    const a = await LLM.run('open netflix', ctx, 'u1');
    ok('tool loop answers in plain text', () => assert.strictEqual(a.text, 'Opening Netflix now.'));
    ok('each model call and tool call is a timeline step', () => assert.ok(steps.length >= 3 && /Thinking \| fake-model · calls launcher_action/.test(steps.join('\n')), steps.join(' / ')));
    ok('launcher_action emitted an action event', () => assert.ok(evs.some(e => e.type === 'action' && e.app === 'netflix'), JSON.stringify(evs)));
    ok('tools + reasoning_effort sent', () => assert.ok(seen[0].tools.length === 5 && seen[0].reasoning_effort === 'low'));
    ok('raw assistant message (thought signature) sent back', () => assert.ok(seen[1].messages.some(m => m.extra_content && m.extra_content.google)));
    await LLM.run('and again', ctx, 'u1');
    ok('memory: second turn includes the first', () => assert.ok(seen[2].messages.some(m => m.role === 'user' && m.content === 'open netflix')));
    await LLM.run('hi', ctx, 'other');
    ok('memory is per session', () => assert.ok(!seen[seen.length - 1].messages.some(m => m.content === 'open netflix')));
    mode = 'ok';
    const g = await ask('open netflix please', { client: 'u9' });
    ok('answer carries stats: model, 2 LLM calls, 220 tokens, 1 tool', () => assert.ok(g.stats.model === 'fake-model' && g.stats.llmCalls === 2 && g.stats.tokens.total === 220 && g.stats.tools === 1 && g.stats.toolMs.launcher_action >= 0, JSON.stringify(g.stats)));
    mode = 'play'; const got = [];
    LLM.setPlayer(async (args, c) => { got.push(args); c.played = { status: 'playing', service: 'youtube', title: 'Innerbloom', via: 'dial' }; return { ok: true, status: 'playing', service: 'youtube', title: 'Innerbloom', say: 'Playing “Innerbloom” on YouTube.' }; });
    const p = await ask('play some other rufus du sol song', { client: 'u7' });
    const toolMsg = seen[seen.length - 1].messages.filter(m => m.role === 'tool').pop();
    ok('play_on_tv tool: args passed, result back to the model, answer carries played', () => assert.ok(got[0].different === true && got[0].service === 'youtube' && /"status":"playing"/.test(toolMsg.content) && p.played && p.played.status === 'playing' && p.chatId, JSON.stringify(p)));
    mode = '429';
    const f = await ask('what\'s the weather tomorrow', { client: 'u1' });
    ok('429 falls back to the built-in brain', () => assert.ok(f.brain === 'built-in' && /tomorrow|°|high/i.test(f.text), JSON.stringify(f)));
    ok('fallback recorded in stats (hop + reason, tokens n/a)', () => assert.ok(f.stats.hops === 1 && /rate-limited/.test(f.stats.fallback) && f.stats.tokens === 'n/a', JSON.stringify(f.stats)));
    console.log(pass + ' LLM client checks passed');
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1; }
  fake.close(); process.exit(process.exitCode || 0);
});
