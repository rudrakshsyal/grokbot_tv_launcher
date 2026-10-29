'use strict';
// LLM brain: one OpenAI-compatible chat/completions client with function calling. Model is chosen by env, so a paid model
// can drop in later with no code change. Each model round-trip and each tool call is a real timeline step.
const https = require('https'), http = require('http'), fs = require('fs'), path = require('path'), { URL } = require('url');
const T = require('./tools'), M = require('./metrics');
const { PLATFORMS } = require('./catalog');
const E = process.env;

// BRAIN_PRESET picks base URL + default model; LLM_BASE_URL / LLM_MODEL / LLM_API_KEY always override.
const PRESETS = {
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash', reasoning: 'low', keyEnv: ['GEMINI_API_KEY'] },
  groq: { base: 'https://api.groq.com/openai/v1/', model: 'openai/gpt-oss-120b', reasoning: 'low', keyEnv: ['GROQ_API_KEY'] },
  ollama: { base: (E.OLLAMA_URL || 'http://localhost:11434') + '/v1/', model: E.OLLAMA_MODEL || 'qwen3:8b', reasoning: '', noKey: true }
};
function presetName() { const p = (E.BRAIN_PRESET || '').toLowerCase(); return PRESETS[p] ? p : E.LLM_BASE_URL ? 'custom' : E.GROQ_API_KEY && !E.LLM_API_KEY && !E.GEMINI_API_KEY ? 'groq' : 'gemini'; }
function endpoints() {
  const list = [], name = presetName(), P = PRESETS[name] || {};
  const add = (ep) => { if (ep.base && ep.model && (ep.key || ep.noKey)) list.push(Object.assign(ep, { base: ep.base.replace(/\/?$/, '/') })); };
  const key = E.LLM_API_KEY || (P.keyEnv || []).map(k => E[k]).filter(Boolean)[0] || (P.noKey ? 'ollama' : '');
  add({ name, base: E.LLM_BASE_URL || P.base, key, model: E.LLM_MODEL || P.model, noKey: P.noKey,
    reasoning: E.LLM_REASONING !== undefined ? E.LLM_REASONING : P.reasoning !== undefined ? P.reasoning : 'low' });
  // optional lighter model / second provider when the primary is rate-limited (e.g. LLM_FALLBACK_MODEL=gemini-3.6-flash)
  if (E.LLM_FALLBACK_MODEL) add({ name: name + '-fallback', base: E.LLM_FALLBACK_BASE_URL || list.length && list[0].base || P.base, key: E.LLM_FALLBACK_API_KEY || key, model: E.LLM_FALLBACK_MODEL, noKey: P.noKey, reasoning: list.length ? list[0].reasoning : 'low' });
  // local Ollama as the last LLM before the rule-based parser (used only if it is running and has the model pulled)
  if (name !== 'ollama' && E.OLLAMA_FALLBACK !== '0') add({ name: 'ollama', base: PRESETS.ollama.base, key: 'ollama', model: PRESETS.ollama.model, noKey: true, reasoning: '', local: true });
  return list;
}
// is Ollama up with the model pulled? (cached 60 s; 400 ms timeout so a missing Ollama costs nothing)
let ollamaCheck = { at: 0, ok: false };
function ollamaUp() {
  if (Date.now() - ollamaCheck.at < 60000) return Promise.resolve(ollamaCheck.ok);
  const want = PRESETS.ollama.model;
  return new Promise(r => {
    const req = http.get(PRESETS.ollama.base.replace(/v1\/$/, '') + 'api/tags', res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => {
      let ok = false; try { ok = (JSON.parse(b).models || []).some(m => m.name === want || m.name === want + ':latest' || m.model === want); } catch (e) {}
      r(ok); }); });
    req.setTimeout(400, () => req.destroy()); req.on('error', () => r(false));
  }).then(ok => { ollamaCheck = { at: Date.now(), ok }; return ok; });
}
const enabled = () => (E.BRAIN || 'auto') !== 'free' && endpoints().length > 0;   // with no key the Ollama entry alone still counts (checked per request)

// ---- zero-cost guard (remote LLMs only; local Ollama is free and never counted) ----
// Daily caps per Pacific calendar day: LLM_MAX_REQUESTS_PER_DAY (default 200 HTTP calls) and LLM_MAX_TOKENS_PER_DAY (default 200000).
// Counter lives in memory + logs/llm-budget.json; on start it is seeded from today's lines in logs/metrics.jsonl (whichever is larger).
// If a provider response mentions billing / paid tier / payment (or HTTP 402), remote LLM calls are refused until
// logs/llm-budget.json is deleted by hand (the latch survives restarts). Over a cap -> Ollama (if running) -> built-in parser.
const BUDGET_DIR = E.METRICS_DIR || path.join(__dirname, 'logs'), BUDGET_FILE = path.join(BUDGET_DIR, 'llm-budget.json');
const BILLING_RE = /billing|paid[\s_-]*tier|pay[\s-]*as[\s-]*you[\s-]*go|prepay|payment required|credit balance|purchase credits|upgrade your plan/i;
function pacificDay(d) { return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
function caps() { return { requests: +(E.LLM_MAX_REQUESTS_PER_DAY || 200), tokens: +(E.LLM_MAX_TOKENS_PER_DAY || 200000) }; }
let BUD = null;
function seedFromLog(day) {
  let requests = 0, tokens = 0;
  try {
    fs.readFileSync(path.join(BUDGET_DIR, 'metrics.jsonl'), 'utf8').split('\n').forEach(l => {
      if (!l) return; let r; try { r = JSON.parse(l); } catch (e) { return; }
      if (r.brain !== 'llm' || pacificDay(new Date(r.ts)) !== day) return;
      requests += r.llmCalls || 0; if (r.tokens && typeof r.tokens === 'object') tokens += r.tokens.total || 0;
    });
  } catch (e) {}
  return { requests, tokens };
}
function budget() {
  const day = pacificDay();
  if (!BUD) { try { BUD = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')); } catch (e) { BUD = {}; } }
  if (BUD.day !== day) {   // new Pacific day (or first run): reset counts, keep a billing latch
    const seed = seedFromLog(day);
    BUD = { day, requests: seed.requests, tokens: seed.tokens, billing: BUD.billing || null };
    saveBudget();
  }
  return BUD;
}
function saveBudget() { try { fs.mkdirSync(BUDGET_DIR, { recursive: true }); fs.writeFileSync(BUDGET_FILE, JSON.stringify(BUD), { mode: 0o600 }); } catch (e) {} }
function budgetBlock() {   // reason string when remote calls must not be sent, else null
  const b = budget(), c = caps();
  if (b.billing) return 'billing indicated \u2014 LLM off';
  if (b.requests >= c.requests || b.tokens >= c.tokens) return 'daily AI limit reached';
  return null;
}
function budgetStatus() { const b = budget(), c = caps(); return { day: b.day, requests: b.requests, tokens: b.tokens, maxRequests: c.requests, maxTokens: c.tokens, blocked: budgetBlock(), billing: b.billing }; }
function checkBilling(ep, status, text) {
  if (ep.local) return;
  if (status === 429) text = String(text || '').replace(/check your plan and billing details/ig, '');   // Gemini's free-tier quota 429 boilerplate is a rate limit, not a charge
  if (status === 402 || BILLING_RE.test(text || '')) { budget().billing = { at: new Date().toISOString(), model: ep.model, status }; saveBudget(); console.warn('LLM billing/paid-tier indication from ' + ep.model + ' \u2014 remote LLM calls disabled (delete relay/logs/llm-budget.json to re-enable)'); }
}

function post(ep, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL('chat/completions', ep.base), data = JSON.stringify(body), lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + ep.key } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; });
      res.on('end', () => {
        checkBilling(ep, res.statusCode, b.slice(0, 4000) + ' ' + JSON.stringify(res.headers));
        if (budget().billing && !ep.local) { const e = new Error('billing indicated \u2014 LLM off'); e.budget = true; return reject(e); }
        if (res.statusCode >= 400) { const e = new Error('LLM HTTP ' + res.statusCode + ' ' + b.slice(0, 200).replace(/\s+/g, ' ')); e.status = res.statusCode; e.body = b.slice(0, 4000);
          try { const j = JSON.parse(b), x = Array.isArray(j) ? j[0] : j; e.apiMessage = String((x.error && x.error.message) || x.message || '').replace(/\s+/g, ' ').slice(0, 160); } catch (x) {} return reject(e); }
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('LLM bad JSON')); }
      });
    });
    req.setTimeout(timeoutMs || (ep.local ? 60000 : 25000), () => req.destroy(new Error('LLM timeout')));
    req.on('error', reject); req.end(data);
  });
}

const TOOLS = [
  { type: 'function', function: { name: 'search_titles', description: 'Find movies/TV shows. Use for recommendations, "what\'s on X", genre/mood, runtime limits, or an actor/director\'s work. Returns real TMDB titles with where to stream (US), runtime and IMDb/Rotten Tomatoes ratings.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'free-text title keywords (only when searching by name)' },
      person: { type: 'string', description: 'actor or director name' },
      kind: { type: 'string', enum: ['movie', 'tv', 'any'] },
      genres: { type: 'array', items: { type: 'string', enum: ['comedy', 'horror', 'action', 'adventure', 'animation', 'crime', 'documentary', 'drama', 'family', 'fantasy', 'history', 'music', 'mystery', 'romance', 'sci-fi', 'thriller', 'war', 'western', 'reality', 'kids'] } },
      max_runtime: { type: 'integer', description: 'max minutes (movie runtime or TV episode length)' },
      platform: { type: 'string', enum: Object.keys(PLATFORMS).filter(k => k !== 'youtube') },
      sort: { type: 'string', enum: ['popular', 'top_rated'] },
      limit: { type: 'integer', description: '1-6, default 3' } } } } },
  { type: 'function', function: { name: 'get_ratings', description: 'IMDb + Rotten Tomatoes ratings and where to stream for one specific title.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, year: { type: 'integer' }, kind: { type: 'string', enum: ['movie', 'tv', 'any'] } }, required: ['title'] } } },
  { type: 'function', function: { name: 'get_weather', description: 'Forecast for the user\'s home (' + (E.WEATHER_PLACE || 'San Jose, CA') + '), Fahrenheit.',
    parameters: { type: 'object', properties: { day: { type: 'string', enum: ['today', 'tomorrow', 'week'] } } } } },
  { type: 'function', function: { name: 'launcher_action', description: 'Control the TV launcher: open a streaming app, or show that service\'s picks in the launcher\'s Discover row.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open_app', 'show_platform'] }, app: { type: 'string', enum: Object.keys(PLATFORMS) } }, required: ['action', 'app'] } } }
];
const STEP_LABEL = { search_titles: 'Searching titles', get_ratings: 'Checking ratings', get_weather: 'Checking the weather', launcher_action: 'TV action' };

function system() {
  const tz = E.HOME_TZ || 'America/Los_Angeles';
  const now = new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return 'You are Yo-Yo, the brief, friendly voice assistant on the user\'s Samsung TV (a custom launcher). The user talks to you from their phone; your reply is shown on the TV and may be read aloud.\n' +
    'Now: ' + now + ' (' + tz + '). Home: ' + (E.WEATHER_PLACE || 'San Jose, CA') + '. Their streaming apps: Netflix, HBO Max, Prime Video, Hulu, Apple TV+, Peacock, Disney+, YouTube.\n' +
    'Rules: Reply in 1-3 short spoken sentences, plain text, no markdown, no lists, no emoji, no URLs. ' +
    'For anything about what to watch, specific titles, ratings, weather, or opening apps, call the tools and only state facts the tools returned (never invent ratings, runtimes or availability). ' +
    'Prefer titles on their services. Mention the top pick by name with its IMDb score. If the user asks to watch/open something, use launcher_action. ' +
    'For general questions (facts, explanations, chit-chat, follow-ups) answer directly from your own knowledge, briefly. Use the conversation so far for follow-ups like "what about on Hulu" or "is the second one good".';
}
// compact tool results for the model (keeps tokens low for free-tier TPM limits)
function forModel(name, r) {
  if (!r) return { error: 'no result' };
  if (r.items) return { total_found: r.total, results: r.items.map(i => ({ title: i.title, kind: i.kind, year: i.year, imdb: i.imdb, rotten_tomatoes: i.rt != null ? i.rt + '%' : null, streaming_on: i.platformName, runtime_min: i.runtime, seasons: i.seasons, genres: i.genres, overview: (i.overview || '').slice(0, 140) })) };
  if (name === 'get_weather') return { place: r.place, now: r.now, today: r.today, tomorrow: r.tomorrow, week: r.week };
  return r;
}

// Conversation memory per phone (client id). Stored as whole turns (user -> [assistant tool_calls -> tool results]* ->
// assistant text) so a slice never orphans a tool message or a tool call. Only the newest FULL_TURNS keep their
// tool calls/results; older turns are compacted to plain user/assistant text (fewer tokens, and nothing for
// Gemini to re-validate). Turns answered by the built-in parser are stored as plain text too.
const SESS = new Map(), IDLE_MS = +(E.LLM_MEMORY_MS || 30 * 60 * 1000), MAX_TURNS = +(E.LLM_MEMORY_TURNS || 8), FULL_TURNS = 2;
function history(id) {
  const s = SESS.get(id), now = Date.now();
  if (!s || now - s.at > IDLE_MS) { const n = { at: now, turns: [], expired: !!(s && s.turns.length) }; SESS.set(id, n); if (SESS.size > 50) SESS.delete(SESS.keys().next().value); return n; }
  s.at = now; return s;
}
function reset(id) { SESS.delete(id || 'default'); }
function textOf(c) { return typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : ''; }
const compactTurn = t => [t[0], { role: 'assistant', content: t.answer || textOf(t[t.length - 1].content) || 'Done.' }];
// a turn is valid if it starts with a non-empty user message, every tool_calls message is followed by exactly its
// tool results (same ids, same order) and it ends with non-empty assistant text
function validTurn(t) {
  if (!t.length || t[0].role !== 'user' || !textOf(t[0].content).trim()) return false;
  for (let i = 1; i < t.length; i++) {
    const m = t[i];
    if (m.role !== 'assistant') return false;
    if (m.tool_calls && m.tool_calls.length) {
      for (let k = 0; k < m.tool_calls.length; k++) { const r = t[i + 1 + k]; if (!r || r.role !== 'tool' || r.tool_call_id !== m.tool_calls[k].id || !m.tool_calls[k].id) return false; }
      i += m.tool_calls.length;
    } else if (i !== t.length - 1 || !textOf(m.content).trim()) return false;
  }
  return t[t.length - 1].role === 'assistant' && !(t[t.length - 1].tool_calls || []).length;
}
// messages to send before the new user message
function memory(s, compactAll) {
  const turns = s.turns.slice(-MAX_TURNS);
  return [].concat.apply([], turns.map((t, i) => (compactAll || i < turns.length - FULL_TURNS || !validTurn(t)) ? compactTurn(t) : t));
}
function remember(id, user, answer) {   // a plain-text turn (built-in parser answers), so follow-ups keep context
  if (!user || !answer) return;
  const s = history(id || 'default'), t = [{ role: 'user', content: user }, { role: 'assistant', content: answer }]; t.answer = answer;
  s.turns.push(t); if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
}
// assistant message as the chat API defines it: tool calls always carry an id (+ Gemini's extra_content thought
// signature, echoed verbatim), no null/empty text, no other provider fields
let callSeq = 0;
function cleanAssistant(msg) {
  const out = { role: 'assistant' }, text = textOf(msg.content);
  if (text.trim()) out.content = text;
  const calls = (msg.tool_calls || []).filter(c => c && c.function && c.function.name).map(c => {
    const o = { id: c.id ? String(c.id) : 'call_' + (++callSeq), type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) } };
    if (c.extra_content) o.extra_content = c.extra_content;
    return o;
  });
  if (calls.length) out.tool_calls = calls;
  if (msg.extra_content) out.extra_content = msg.extra_content;
  return out;
}
const LANG_RULE = {
  'hi-IN': 'The user chose Hindi: reply in simple spoken Hindi in Devanagari script (titles may stay in English).',
  'en-IN': 'The user chose English (India): they may mix Hindi and English; reply in the same style (Hinglish in Latin script is fine).'
};
const isTransient = err => err.status === 429 || err.status >= 500 || err.status === 401 || err.status === 403 || /timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/.test(err.message);
const retryDelayMs = err => { const m = /retry(?:Delay|[ -]after)?"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)s/i.exec(err.body || err.message || ''); return m ? Math.ceil(+m[1] * 1000) : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chat(ep, messages, ctx, round) {
  const body = { model: ep.model, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: +(E.LLM_MAX_TOKENS || 1024) };
  if (ep.reasoning) body.reasoning_effort = ep.reasoning;   // Gemini & gpt-oss accept low/medium/high; LLM_REASONING= (empty) omits it
  if (E.LLM_TEMPERATURE) body.temperature = +E.LLM_TEMPERATURE;
  let msg;
  await ctx.step(round === 0 ? 'Thinking' : 'Reading results', async () => {
    if (!ep.local) {
      const why = budgetBlock(); if (why) { const e = new Error(why); e.budget = true; throw e; }
      budget().requests++; saveBudget();
    }
    const t = Date.now(), r = await post(ep, body);
    if (!ep.local && r.usage) { budget().tokens += r.usage.total_tokens || ((r.usage.prompt_tokens || 0) + (r.usage.completion_tokens || 0)); saveBudget(); }
    ctx.metrics && ctx.metrics.llm(ep.model, Date.now() - t, r.usage);
    msg = (r.choices && r.choices[0] && r.choices[0].message) || {};
    const calls = (msg.tool_calls || []).map(c => c.function && c.function.name);
    return ep.model + ' \u00b7 ' + (calls.length ? 'calls ' + calls.join(', ') : 'writing answer');
  });
  return msg;
}
const cancelled = ctx => !!(ctx.cancelled && ctx.cancelled());
function cancelErr() { const e = new Error('cancelled (newer question)'); e.cancelled = true; return e; }

// one attempt on one endpoint; resolves { text, items, brain } and stores the turn, or throws
async function attempt(ep, text, ctx, s, base, lang) {
  const sys = system() + (LANG_RULE[lang] ? '\n' + LANG_RULE[lang] : '');
  const turn = [{ role: 'user', content: text }], items = [];
  for (let round = 0; round < 5; round++) {
    if (cancelled(ctx)) throw cancelErr();
    const raw = await chat(ep, [{ role: 'system', content: sys }].concat(base, turn), ctx, round);
    const msg = cleanAssistant(raw), calls = msg.tool_calls || [];
    if (!calls.length) {
      const answer = textOf(raw.content).replace(/[*_#`]/g, '').trim() || 'Done.';
      if (!msg.content) msg.content = answer;   // never store empty assistant text
      turn.push(msg); turn.answer = answer;
      if (cancelled(ctx)) throw cancelErr();      // a superseded question doesn't overwrite newer memory
      s.turns.push(turn); if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS); s.at = Date.now();
      return { text: answer, items: pickItems(answer, items), brain: ep.model };
    }
    turn.push(msg);
    for (const c of calls) {   // all results right after their calls, same order (Gemini rejects interleaving)
      let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch (x) {}
      let res;
      try {
        const fn = { search_titles: T.searchTitles, get_ratings: T.getRatings, get_weather: T.getWeather, launcher_action: T.launcherAction }[c.function.name];
        res = fn ? await M.timeTool(ctx, c.function.name, args, () => fn(args, ctx)) : { error: 'unknown tool' };
        if (res && res.items) res.items.forEach(i => { if (!items.some(x => x.id === i.id)) items.push(i); });
      } catch (x) { res = { error: x.user || x.message }; }
      turn.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(forModel(c.function.name, res)) });
    }
  }
  throw new Error('too many tool rounds');
}

async function run(text, ctx, sessionId, opts) {
  opts = opts || {};
  const eps = endpoints(), s = history(sessionId || 'default');
  if (!s.turns.length && ctx.step) await ctx.step('New conversation', async () => (s.expired ? 'previous chat expired after ' + Math.round(IDLE_MS / 60000) + ' min idle \u00b7 ' : '') + ('memory keeps ' + MAX_TURNS + ' turns, resets after ' + Math.round(IDLE_MS / 60000) + ' min idle'));
  else if (ctx.step) await ctx.step('Remembering', async () => s.turns.length + ' earlier turn' + (s.turns.length === 1 ? '' : 's'));
  let lastErr = null;
  for (let e = 0; e < eps.length; e++) {
    const ep = eps[e];
    if (ep.local && !(await ollamaUp())) continue;
    if (!ep.local) { const why = budgetBlock(); if (why) { lastErr = Object.assign(new Error(why), { budget: true, model: ep.model }); if (ctx.metrics) ctx.metrics.hop(ep.model, why); continue; } }
    let compact = false, waited = false;
    for (;;) {
      try { return await attempt(ep, text, ctx, s, memory(s, compact), opts.lang); }
      catch (err) {
        lastErr = err; err.model = ep.model;
        if (err.cancelled) throw err;
        if (err.budget) { if (ctx.metrics) ctx.metrics.hop(ep.model, err.message); break; }   // cap hit mid-request / billing: try Ollama, never another paid call
        const why = M.reason(err);
        console.warn('LLM ' + ep.model + ' failed (' + why + ')' + (compact ? ' [compact memory]' : '') + ':', String(err.message).slice(0, 240));
        // a request the API rejects (e.g. 400 on the stored history): retry once with memory as plain user/assistant text
        if (!isTransient(err) && !compact && s.turns.length) {
          compact = true; if (ctx.metrics) ctx.metrics.hop(ep.model, why + ' \u2192 retry, plain memory');
          if (ctx.step) await ctx.step('Retrying', async () => why + ' \u00b7 memory as plain text').catch(() => {});
          continue;
        }
        // short free-tier rate limit (Gemini sends retryDelay): wait once if it's only a few seconds
        const d = err.status === 429 ? retryDelayMs(err) : null;
        if (d != null && d <= 6000 && !waited) { waited = true; if (ctx.metrics) ctx.metrics.hop(ep.model, why + ' \u2192 waited ' + Math.ceil(d / 1000) + ' s'); await sleep(d); continue; }
        if (!isTransient(err)) { e = eps.length; break; }   // not fixable by another model: built-in parser
        if (e < eps.length - 1 && ctx.metrics) ctx.metrics.hop(ep.model, why);
        break;
      }
    }
  }
  if (!lastErr) { const x = new Error('no LLM available'); x.noLLM = true; throw x; }
  throw lastErr;
}
// show the titles the answer actually talks about (in that order); otherwise the tool results
function pickItems(answer, items) {
  const a = answer.toLowerCase();
  const hit = items.filter(i => i.title && a.indexOf(i.title.toLowerCase()) >= 0).sort((x, y) => a.indexOf(x.title.toLowerCase()) - a.indexOf(y.title.toLowerCase()));
  return (hit.length ? hit : items).slice(0, 4);
}
function describe() { const e = endpoints()[0]; return e ? e.model + ' @ ' + e.base.replace(/^https?:\/\//, '').split('/')[0] : null; }
module.exports = { budgetStatus, pacificDay, run, remember, reset, memory, validTurn, cleanAssistant, IDLE_MS, MAX_TURNS, enabled, describe, endpoints, ollamaUp, post, SESS, STEP_LABEL, PRESETS };
