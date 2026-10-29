// Multi-turn memory test against a STRICT fake OpenAI-compatible server that validates every request the way Gemini's
// OpenAI-compat layer does (no real LLM calls, no keys). Validation per request:
//   system first, then user; only role/content/tool_calls/tool_call_id/name/extra_content keys; no null/empty text;
//   every assistant tool_calls message has ids + type + string arguments and is followed by exactly its tool results
//   (same ids, same order, with name); no orphan tool messages; the first call of each step in the CURRENT turn
//   carries its thought signature (extra_content.google.thought_signature) -> otherwise HTTP 400 like Gemini.
// Also: compact-memory retry on a 400, parser fallback stored in memory, idle expiry, /chat/reset, language rule,
// 429 retryDelay wait, and two overlapping /ask requests.
// usage: node relay/test/llm-multiturn.test.js
const http = require('http'), assert = require('assert');
const seen = [], rejects = []; let mode = 'ok', delay = 0, n429 = 0;
const KEYS = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name', 'extra_content']);
function validate(ms) {
  const bad = m => { throw Object.assign(new Error(m), { code: 400 }); };
  if (!ms.length || ms[0].role !== 'system') bad('first message must be system');
  if (!ms[1] || ms[1].role !== 'user') bad('first non-system message must be user');
  let curStart = 0; ms.forEach((m, i) => { if (m.role === 'user') curStart = i; });
  for (let i = 1; i < ms.length; i++) {
    const m = ms[i];
    Object.keys(m).forEach(k => { if (!KEYS.has(k)) bad('unknown field ' + k + ' in message ' + i); });
    if ('content' in m && (m.content === null || (typeof m.content === 'string' && !m.content.trim()))) bad('empty text parameter in message ' + i);
    if (m.role === 'user') { if (typeof m.content !== 'string' || !m.content.trim()) bad('user without text ' + i); continue; }
    if (m.role === 'tool') bad('orphan tool message ' + i);
    if (m.role !== 'assistant') bad('bad role ' + m.role);
    if (!m.content && !(m.tool_calls || []).length) bad('assistant without content or tool_calls ' + i);
    if ((m.tool_calls || []).length) {
      m.tool_calls.forEach((c, k) => {
        if (!c.id || c.type !== 'function' || !c.function || !c.function.name || typeof c.function.arguments !== 'string') bad('malformed tool call ' + i);
        if (i > curStart && k === 0 && !(c.extra_content && c.extra_content.google && c.extra_content.google.thought_signature)) bad('Function call ' + c.function.name + ' in the ' + i + '. content block is missing a thought_signature');
      });
      m.tool_calls.forEach((c, k) => { const r = ms[i + 1 + k]; if (!r || r.role !== 'tool' || r.tool_call_id !== c.id || r.name !== c.function.name || !r.content) bad('tool call ' + c.id + ' not answered in order'); });
      i += m.tool_calls.length;
    }
  }
  const last = ms[ms.length - 1]; if (last.role !== 'user' && last.role !== 'tool') bad('last message must be user or tool');
}
let sig = 0, idn = 0;
const call = (name, args, noId) => ({ role: 'assistant', content: '', tool_calls: [Object.assign(noId ? {} : { id: 'fc_' + (++idn) }, { type: 'function', function: { name, arguments: JSON.stringify(args) }, extra_content: { google: { thought_signature: 'sig' + (++sig) } } })] });
const say = t => ({ role: 'assistant', content: t, extra_content: { google: { thought_signature: 'tsig' + (++sig) } }, refusal: null });
function reply(ms) {
  const lastUser = [...ms].reverse().find(m => m.role === 'user').content, last = ms[ms.length - 1];
  const hist = JSON.stringify(ms.slice(1, ms.lastIndexOf(ms.find(m => m.role === 'user' && m.content === lastUser))));
  if (/funny movie/.test(lastUser)) return last.role === 'tool' ? say('Try **The Nice Guys** on Netflix, it runs about two hours. 😂') : call('search_titles', { genres: ['comedy'], platform: 'netflix', kind: 'movie' }, true);
  if (/shorter/.test(lastUser)) return say(/Nice Guys/.test(hist) && /funny movie/.test(hist) ? 'Shorter than The Nice Guys: Game Night is 100 minutes.' : 'Shorter than what?');
  if (/open it/.test(lastUser)) return last.role === 'tool' ? say(/Game Night/.test(hist) ? 'Opening Netflix for Game Night.' : 'Opening Netflix.') : call('launcher_action', { action: 'open_app', app: 'netflix' });
  if (/what did I ask first/.test(lastUser)) return say(/funny movie/.test(hist) ? 'You first asked for a funny movie on Netflix.' : 'I do not remember.');
  if (/namaste/i.test(lastUser)) return say(/Hindi/.test(ms[0].content) ? 'नमस्ते! मैं आपकी क्या मदद करूँ?' : 'Hello!');
  return say('Okay. ' + (/weather tomorrow/.test(hist) ? 'You asked about the weather tomorrow.' : 'No earlier weather question.'));
}
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const body = JSON.parse(b); seen.push({ mode, body });
    const send = (code, o) => setTimeout(() => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }, delay);
    if (mode === '429once' && n429++ === 0) return send(429, [{ error: { code: 429, message: 'Resource exhausted. Please retry in 1s.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] } }]);
    try { validate(body.messages); } catch (e) { rejects.push(e.message); return send(400, [{ error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } }]); }
    const cur = body.messages.slice([...body.messages].map(m => m.role).lastIndexOf('user'));
    const oldTools = body.messages.slice(0, body.messages.length - cur.length).some(m => m.role === 'tool');
    if (mode === 'rejectOldTools' && oldTools) return send(400, [{ error: { code: 400, message: 'Please ensure that function response turn comes immediately after a function call turn.', status: 'INVALID_ARGUMENT' } }]);
    if (mode === 'reject') return send(400, [{ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }]);
    send(200, { choices: [{ message: reply(body.messages), finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } });
  });
});
const httpPost = (port, p, o) => new Promise((resolve, reject) => { const d = JSON.stringify(o); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); }); r.on('error', reject); r.end(d); });

fake.listen(0, '127.0.0.1', async () => {
  Object.assign(process.env, { METRICS_DIR: require('fs').mkdtempSync(require('os').tmpdir() + '/llmm-'), METRICS: '0', LLM_BASE_URL: 'http://127.0.0.1:' + fake.address().port + '/v1/', LLM_API_KEY: 'test', LLM_MODEL: 'fake-gemini', OLLAMA_FALLBACK: '0', LOG: '0', TMDB_API_KEY: '', OMDB_API_KEY: '' });
  const origWarn = console.warn, warns = []; console.warn = (...a) => warns.push(a.join(' '));
  const S = require('../server'), LLM = require('../brain-llm'), ask = S.ask;
  let pass = 0; const ok = (name, c, info) => { assert.ok(c, name + (info ? ' :: ' + info : '')); pass++; console.log('PASS', name); };
  const reqsSince = k => seen.slice(k).map(x => x.body);
  try {
    // --- 3 turns incl. tool calls, strict validation on every request ---
    let k = seen.length;
    const a1 = await ask('find a funny movie on Netflix', { client: 'tv-user' });
    ok('turn 1: tool call (no id from the model) -> answer', a1.brain === 'fake-gemini' && /Nice Guys/.test(a1.text) && !/\*/.test(a1.text), JSON.stringify(a1.stats && a1.stats.fallback));
    ok('turn 1: synthesized tool_call id matched by the tool result', reqsSince(k)[1].messages.some(m => m.role === 'tool' && /^call_/.test(m.tool_call_id)));
    ok('spoken field: no markdown/emoji, max 2 sentences', a1.spoken === 'Try The Nice Guys on Netflix, it runs about two hours.', a1.spoken);
    k = seen.length;
    const a2 = await ask('what about something shorter?', { client: 'tv-user' });
    ok('turn 2: follow-up gets turn 1 context (strict server accepted the history)', a2.brain === 'fake-gemini' && /Game Night/.test(a2.text), a2.text + ' ' + JSON.stringify(a2.stats.fallback));
    const r2 = reqsSince(k)[0].messages;
    ok('turn 2 history: user, tool_calls, tool, answer (no null/empty content, no provider extras)', r2.length === 6 && r2[2].tool_calls && !('content' in r2[2]) && r2[3].role === 'tool' && !('refusal' in r2[4]), JSON.stringify(r2.map(m => m.role)));
    k = seen.length;
    const a3 = await ask('open it', { client: 'tv-user' });
    ok('turn 3: tool call in a later turn works and uses context', a3.brain === 'fake-gemini' && a3.text === 'Opening Netflix for Game Night.' && a3.stats.hops === 0, a3.text);
    ok('every request so far passed strict validation (no 400s)', rejects.length === 0 && seen.length === 5 && a1.stats.hops === 0 && a2.stats.hops === 0, rejects.join('; '));
    const a4 = await ask('what did I ask first?', { client: 'tv-user' });
    const r4 = seen[seen.length - 1].body.messages;
    ok('turn 4: oldest turn compacted to plain text (only the last 2 turns keep tool calls)', /funny movie/.test(a4.text) && r4[2].role === 'assistant' && !r4[2].tool_calls && /Nice Guys/.test(r4[2].content), JSON.stringify(r4.slice(1, 4)));
    ok('memory is per phone', !(await (async () => { await ask('what about something shorter?', { client: 'other' }); return /Game Night/.test(seen[seen.length - 1].body.messages.map(m => m.content).join(' ')); })()));

    // --- a 400 on the stored history: retry once with memory as plain text ---
    mode = 'rejectOldTools'; k = seen.length;
    const b1 = await ask('what about something shorter?', { client: 'tv-user' });
    ok('400 on history -> retried with plain-text memory -> LLM answer (not the parser)', b1.brain === 'fake-gemini' && /Game Night/.test(b1.text) && /retry, plain memory/.test(b1.stats.fallback), JSON.stringify(b1.stats.fallback));
    ok('retry request has no old tool messages', !reqsSince(k)[1].messages.some(m => m.role === 'tool'));
    ok('clear reason in stats line + log', /HTTP 400: Please ensure that function response/.test(b1.stats.fallback) && warns.some(w => /fake-gemini failed \(HTTP 400: Please ensure/.test(w)), b1.stats.fallback);

    // --- persistent 400: parser fallback, and that turn is remembered ---
    mode = 'reject';
    const c1 = await ask('open hulu', { client: 'p2' });
    ok('persistent 400 -> built-in parser (no retry without history)', c1.brain === 'built-in' && /Opening Hulu/.test(c1.text) && /HTTP 400: Request contains an invalid argument/.test(c1.stats.fallback), JSON.stringify(c1).slice(0, 300));
    mode = 'ok';
    await ask('and the day after?', { client: 'p2' });
    ok('parser turn stored as plain text memory for the next LLM turn', seen[seen.length - 1].body.messages.some(m => m.role === 'user' && m.content === 'open hulu') && seen[seen.length - 1].body.messages.some(m => m.role === 'assistant' && /Opening Hulu/.test(m.content)));

    // --- idle expiry (30 min default) + explicit reset ---
    ok('memory idle default is 30 min, 8 turns', LLM.IDLE_MS === 30 * 60 * 1000 && LLM.MAX_TURNS === 8);
    LLM.SESS.get('tv-user').at = Date.now() - 12 * 60 * 1000;
    await ask('what did I ask first?', { client: 'tv-user' });
    ok('12 min later the chat is still remembered', /funny movie/.test(JSON.stringify(seen[seen.length - 1].body.messages)));
    LLM.SESS.get('tv-user').at = Date.now() - 31 * 60 * 1000;
    const steps = []; await LLM.run('what did I ask first?', { step: async (l, fn) => { const d = await fn(); steps.push(l + ' | ' + d); return d; } }, 'tv-user');
    ok('after 31 min idle: new conversation, marked expired', /New conversation \| previous chat expired/.test(steps.join('\n')) && !/funny movie/.test(JSON.stringify(seen[seen.length - 1].body.messages.slice(1, -1))), steps[0]);

    const srv = S.server.listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r)); const port = srv.address().port;
    await ask('find a funny movie on Netflix', { client: 'rz' });
    ok('POST /chat/reset clears that phone\'s memory', (await httpPost(port, '/chat/reset', { client: 'rz' })).ok && !LLM.SESS.has('rz'));

    // --- language rule ---
    const h = await httpPost(port, '/ask', { text: 'namaste', client: 'hin', lang: 'hi-IN' });
    ok('lang hi-IN -> system rule (Devanagari) -> Hindi reply + spoken', /Devanagari/.test(seen[seen.length - 1].body.messages[0].content) && /नमस्ते/.test(h.text) && /नमस्ते/.test(h.spoken), h.text);
    await httpPost(port, '/ask', { text: 'namaste', client: 'hin2', lang: 'xx-evil' });
    ok('unknown lang ignored (en-US, no extra rule)', !/user chose/.test(seen[seen.length - 1].body.messages[0].content));

    // --- 429 with a short retryDelay waits once ---
    mode = '429once'; n429 = 0;
    const r429 = await ask('what about something shorter?', { client: 'q' });
    ok('429 retryDelay 1s -> waited, then answered by the LLM', r429.brain === 'fake-gemini' && /waited 1 s/.test(r429.stats.fallback), JSON.stringify(r429.stats.fallback));
    mode = 'ok';

    // --- two overlapping /ask requests ---
    delay = 400; const t0 = Date.now();
    const p1 = httpPost(port, '/ask', { text: 'find a funny movie on Netflix', client: 'cc' });
    await new Promise(r => setTimeout(r, 150));
    const p2 = httpPost(port, '/ask', { text: 'what about something shorter?', client: 'cc' });
    const [o1, o2] = await Promise.all([p1, p2]);
    ok('overlapping /ask: first answered "superseded" right away (not a 90 s timeout)', o1.type === 'error' && o1.superseded && Date.now() - t0 < 5000, JSON.stringify(o1));
    ok('overlapping /ask: second gets a normal answer', o2.type === 'answer' && o2.text, JSON.stringify(o2).slice(0, 200));
    ok('superseded turn did not write memory', !(LLM.SESS.get('cc').turns || []).some(t => /funny/.test(t[0].content)), JSON.stringify(LLM.SESS.get('cc').turns.map(t => t[0].content)));
    delay = 0; srv.close();
    console.log(pass + ' multi-turn checks passed');
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1; }
  console.warn = origWarn; fake.close(); process.exit(process.exitCode || 0);
});
