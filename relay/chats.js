'use strict';
// Persistent chats (v6). One JSON file per chat in relay/data/chats/<id>.json (gitignored, local only, never sent anywhere
// except as LLM context). A chat survives page reloads, a new phone/client id (PWA vs Safari), and relay restarts.
//   messages: what the phone shows (every user/assistant bubble, capped at MAX_MESSAGES)
//   turns:    the last LLM_MEMORY_TURNS (8) turns verbatim, in chat/completions shape (tool calls kept for the newest 2)
//   older:    turns that slid out of `turns` and are not yet folded into `summary` (sent as short plain lines)
//   summary:  rolling short summary of everything older (written by brain-llm.summarize, or extractive when no LLM)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = process.env.CHATS_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'chats');
const MAX_MESSAGES = 400, MAX_CHATS = 300, ID_RE = /^c[a-z0-9]{8,24}$/;
const cache = new Map();
const validId = id => typeof id === 'string' && ID_RE.test(id);
function file(id) { return path.join(DIR, id + '.json'); }
// strictly increasing, so two changes in the same millisecond still sort newest first
let lastStamp = 0;
function stamp() { lastStamp = Math.max(Date.now(), lastStamp + 1); return lastStamp; }
function newId() { return 'c' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function blank(id, o) {
  const now = stamp();
  return { id: id || newId(), title: (o && o.title) || 'New chat', autoTitle: !(o && o.title), created: now, updated: now, client: (o && o.client) || null,
    summary: '', older: [], turns: [], messages: [] };
}
function load(id) {
  if (!validId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const c = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    if (!c || c.id !== id) return null;
    c.turns = (Array.isArray(c.turns) ? c.turns : []).map(x => { if (Array.isArray(x)) return x; const t = (x && Array.isArray(x.m)) ? x.m : []; t.answer = x && x.answer || undefined; return t; }).filter(t => t.length);
    c.older = Array.isArray(c.older) ? c.older : []; c.messages = Array.isArray(c.messages) ? c.messages : [];
    cache.set(id, c); return c;
  } catch (e) { return null; }
}
// turns are arrays with an extra .answer property: JSON drops it, so store it as a trailing marker object
function serialize(c) {
  const o = Object.assign({}, c, { turns: c.turns.map(t => ({ m: t, answer: t.answer || null })) });
  return JSON.stringify(o);
}
const get = load;
function save(c) {
  if (!c || !validId(c.id)) return;
  c.updated = stamp();
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmp = file(c.id) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, serialize(c), { mode: 0o600 }); fs.renameSync(tmp, file(c.id));
  } catch (e) { console.warn('could not save chat ' + c.id + ': ' + e.message); }
  cache.set(c.id, c);
}
function create(o) { const c = blank(null, o); save(c); prune(); return c; }
// the chat for this request: the one asked for (if it exists), else a new one
function open(id, o) { return get(id) || create(o); }
function list() {
  let ids = [];
  try { ids = fs.readdirSync(DIR).filter(f => /\.json$/.test(f)).map(f => f.slice(0, -5)).filter(validId); } catch (e) {}
  cache.forEach((c, id) => { if (ids.indexOf(id) < 0 && fs.existsSync(file(id))) ids.push(id); });
  return ids.map(get).filter(Boolean).sort((a, b) => b.updated - a.updated).map(summaryOf);
}
function summaryOf(c) {
  const last = c.messages[c.messages.length - 1];
  return { id: c.id, title: c.title, updated: c.updated, created: c.created, count: c.messages.length, preview: last ? String(last.text || '').slice(0, 90) : '' };
}
function rename(id, title) {
  const c = get(id); if (!c) return null;
  c.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60) || c.title; c.autoTitle = false; save(c); return summaryOf(c);
}
function remove(id) {
  if (!validId(id)) return false;
  cache.delete(id);
  try { fs.unlinkSync(file(id)); return true; } catch (e) { return false; }
}
function prune() {   // keep the newest MAX_CHATS chats
  const all = list(); all.slice(MAX_CHATS).forEach(c => remove(c.id));
}
// a display message (what the phone shows)
function addMessage(c, m) {
  if (!c) return;
  // v6.2: every message gets a short id (phone "Show on TV" -> POST /tv/show { chatId, messageId }); older messages have none
  const msg = { id: 'm' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), role: m.role, text: String(m.text || '').slice(0, 4000), ts: Date.now() };
  ['brain', 'voice', 'items', 'stats', 'played', 'lang'].forEach(k => { if (m[k] != null) msg[k] = m[k]; });
  c.messages.push(msg); if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
  if (c.autoTitle && m.role === 'user' && c.messages.filter(x => x.role === 'user').length === 1) c.title = titleFrom(m.text);
  save(c);
  return msg;
}
// a message by id, or by index for chats saved before v6.2 (messages without ids)
function findMessage(c, messageId, index) {
  if (!c || !c.messages) return null;
  if (messageId) { for (let i = 0; i < c.messages.length; i++) if (c.messages[i].id === messageId) return { msg: c.messages[i], index: i }; return null; }
  const i = Number(index);
  if (index == null || index === '' || !Number.isInteger(i) || i < 0 || i >= c.messages.length) return null;
  return { msg: c.messages[i], index: i };
}
function titleFrom(t) {
  const w = String(t || '').replace(/[\r\n]+/g, ' ').replace(/^(hey|hi|ok|okay|so|please|yo-?yo)[,!\s]+/i, '').trim().split(/\s+/);
  let s = w.slice(0, 6).join(' '); if (w.length > 6) s += '\u2026';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.slice(0, 60) || 'New chat';
}
module.exports = { get, open, create, save, list, rename, remove, addMessage, findMessage, titleFrom, validId, summaryOf, DIR, cache };
