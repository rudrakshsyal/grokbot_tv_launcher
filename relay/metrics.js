'use strict';
// Per-request metrics: brain/model, fallback hops, LLM calls + token usage (from the API's usage field), tool timings,
// time to first progress step, total time. One JSON line per request in relay/logs/metrics.jsonl (local only, no keys).
// aggregate() is pure (unit-tested in test/metrics.test.js) and backs GET /stats.
const fs = require('fs'), path = require('path');
const LOG_DIR = process.env.METRICS_DIR || path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'metrics.jsonl');

function begin(text, o) {
  o = o || {};
  const t0 = Date.now();
  return {
    t0, text, client: o.client || 'default', typed: !!o.typed,
    llmCalls: 0, llmMs: 0, tokens: { prompt: 0, completion: 0, total: 0, known: false }, models: [],
    tools: [], steps: [], actions: [], hops: [], firstStepMs: null,
    llm(model, ms, usage) {
      this.llmCalls++; this.llmMs += ms; if (this.models.indexOf(model) < 0) this.models.push(model);
      if (usage && (usage.total_tokens != null || usage.prompt_tokens != null)) {
        const p = +usage.prompt_tokens || 0, c = +usage.completion_tokens || 0;
        this.tokens.prompt += p; this.tokens.completion += c; this.tokens.total += +usage.total_tokens || p + c; this.tokens.known = true;
      }
    },
    tool(name, ms, args, res, err) {
      this.tools.push({ name, ms, args: args || {}, titles: res && res.items ? res.items.map(i => i.title) : [],
        items: res && res.items ? res.items.map(i => ({ title: i.title, imdb: i.imdb, runtime: i.runtime, kind: i.kind, platforms: i.platforms, platform: i.platform, genres: i.genreAll || i.genres, year: i.year })) : [], error: err || (res && res.error) || null });
    },
    step(label, ms, state) {
      this.steps.push({ label, ms, state });
      if (this.firstStepMs == null && label !== 'Heard you') this.firstStepMs = Date.now() - t0;   // first real progress the TV shows
    },
    hop(from, reason) { this.hops.push({ from, reason: String(reason || '').slice(0, 100) }); }
  };
}
// wraps one tool call so both brains report the same tool timings
async function timeTool(ctx, name, args, fn) {
  const t = Date.now();
  try { const r = await fn(); ctx.metrics && ctx.metrics.tool(name, Date.now() - t, args, r); return r; }
  catch (e) { ctx.metrics && ctx.metrics.tool(name, Date.now() - t, args, null, String(e.user || e.message).slice(0, 80)); throw e; }
}
function reason(e) {
  if (!e) return null;
  if (e.budget) return e.message;
  return e.status === 429 ? 'rate-limited' : e.status === 401 || e.status === 403 ? 'key rejected' : e.status >= 500 ? 'server ' + e.status : /timeout/i.test(e.message) ? 'timeout' : e.status ? 'HTTP ' + e.status + (e.apiMessage ? ': ' + e.apiMessage.slice(0, 60) : '') : String(e.message || 'error').slice(0, 60);
}
// compact object sent on the answer SSE event (and returned by POST /ask)
function stats(m, brain, err) {
  const toolMs = {};
  m.tools.forEach(t => { toolMs[t.name] = (toolMs[t.name] || 0) + t.ms; });
  const llm = brain && brain !== 'built-in';
  return {
    brain: llm ? 'llm' : 'free', model: brain || 'built-in', llmCalls: m.llmCalls,
    tokens: m.tokens.known ? { prompt: m.tokens.prompt, completion: m.tokens.completion, total: m.tokens.total } : 'n/a',
    llmMs: m.llmMs, toolMs, tools: m.tools.length, firstStepMs: m.firstStepMs, totalMs: Date.now() - m.t0,
    hops: m.hops.length, fallback: m.hops.length ? m.hops.map(h => h.from + ': ' + h.reason).join(' \u2192 ') : null, error: err || null,
    steps: m.steps.map(s => ({ label: s.label, ms: s.ms, state: s.state }))
  };
}
function record(m, st, extra) {
  const rec = Object.assign({ ts: new Date(m.t0).toISOString(), text: m.text, client: m.client }, st, extra || {});
  delete rec.steps;
  rec.tools = m.tools.map(t => ({ name: t.name, ms: t.ms, n: t.titles.length, error: t.error }));
  if (process.env.METRICS !== '0') {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n'); } catch (e) {}
  }
  return rec;
}
function read(file) {
  try { return fs.readFileSync(file || LOG_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}
function pct(sorted, p) { if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]; }
function summarize(recs) {
  const ms = recs.map(r => r.totalMs).filter(x => x != null).sort((a, b) => a - b);
  const tok = recs.filter(r => r.tokens && typeof r.tokens === 'object');
  const models = {};
  recs.forEach(r => { models[r.model] = (models[r.model] || 0) + 1; });
  const sum = tok.reduce((a, r) => a + (r.tokens.total || 0), 0);
  return {
    requests: recs.length, errors: recs.filter(r => r.error).length,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, p50Ms: pct(ms, 50), p95Ms: pct(ms, 95),
    tokens: sum, promptTokens: tok.reduce((a, r) => a + (r.tokens.prompt || 0), 0), completionTokens: tok.reduce((a, r) => a + (r.tokens.completion || 0), 0),
    avgTokens: tok.length ? Math.round(sum / tok.length) : null, llmCalls: recs.reduce((a, r) => a + (r.llmCalls || 0), 0),
    fallbackRate: recs.length ? +(recs.filter(r => r.hops > 0).length / recs.length).toFixed(3) : 0, models
  };
}
function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }   // local day (relay host's zone)
function aggregate(recs, now) {
  const today = dayKey(now || new Date());
  const t = recs.filter(r => dayKey(new Date(r.ts)) === today);
  return { today: summarize(t), all: summarize(recs), last: recs.length ? recs[recs.length - 1] : null };
}
module.exports = { begin, timeTool, reason, stats, record, read, aggregate, summarize, pct, LOG_FILE };
