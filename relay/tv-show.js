'use strict';
// v6.2 "Show on TV": the phone asks for one stored chat answer to be shown big on the TV.
//   POST /tv/show  { chatId, messageId | index }  (JSON only; phone page)
//     -> if the launcher isn't the visible app: remember which dock app was visible (REST appStatus, never key presses),
//        bring GlassHome1.launcher to the front (tv.launch, REST first, no pairing prompt), then push
//        { type: 'tv-show', id, question, text, prev } over the SSE channel. The push is kept as "pending" for
//        PENDING_MS so a launcher that is still starting (or resuming from the background) gets it when it connects.
//   GET  /tv/pending            -> { pending: <the tv-show event> | null }       (launcher, on resume)
//   POST /tv/shown { id }       -> ack from the launcher; clears the pending push
//   POST /tv/back  { id }       -> relaunches the app that was visible before that show (only the one remembered for id)
// No LLM calls: the text is the answer already stored in the chat.
const crypto = require('crypto');
const PENDING_MS = 60000, BACK_MS = 3 * 3600 * 1000;
const isVisible = st => !!st && (st.visible === true || String(st.visible) === 'true');
const withTimeout = (p, ms) => Promise.race([p, new Promise((r, j) => setTimeout(() => j(new Error('timeout')), ms))]);

function create(o) {
  const tv = o.tv, power = o.power, DOCK = o.dock, CH = o.chats, send = o.send, clientCount = o.clients || (() => 0), log = o.log || (() => {});
  const pendingMs = o.pendingMs || PENDING_MS, statusMs = o.statusMs || 1500;
  let pending = null, last = null;   // last: the most recent show (for /tv/back), kept after the ack

  const fresh = () => pending && Date.now() - pending.at < pendingMs ? pending : (pending = null);
  const payload = p => { const e = Object.assign({}, p.ev); return e; };

  async function show(b) {
    const chatId = String(b.chatId || ''), messageId = b.messageId ? String(b.messageId).slice(0, 40) : null;
    if (!CH.validId(chatId)) return [400, { ok: false, error: 'bad-chat' }];
    const c = CH.get(chatId); if (!c) return [404, { ok: false, error: 'no-chat' }];
    const f = CH.findMessage(c, messageId, messageId ? null : b.index);
    if (!f || f.msg.role !== 'assistant' || !f.msg.text || f.msg.brain === 'error') return [404, { ok: false, error: 'no-message' }];
    let question = '';
    for (let i = f.index - 1; i >= 0; i--) if (c.messages[i].role === 'user') { question = c.messages[i].text; break; }
    if (power && power.power === 'off') return [409, { ok: false, error: 'tv-off', message: 'The TV is off. Turn it on first.' }];
    const d = DOCK.load(), L = d.launcher.appId;
    let front = false, prev = null, via = null;
    try { front = isVisible(await withTimeout(tv.appStatus(L), statusMs)); } catch (e) { front = false; }
    if (!front) {
      // which dock app is on screen right now (REST only: a visible app reports visible:true)
      const st = await Promise.all(d.apps.map(a => withTimeout(tv.appStatus(a.appId), statusMs).then(s => isVisible(s), () => false)));
      const i = st.indexOf(true); if (i >= 0) prev = { key: d.apps[i].key, name: d.apps[i].name, appId: d.apps[i].appId };
      try { via = (await tv.launch(L, { noPair: true })).via; }
      catch (e) { return [503, { ok: false, error: e.code || 'launch-failed', message: 'Couldn\u2019t bring Home to the front: ' + String(e.message || '').slice(0, 120) }]; }
    }
    const id = 's' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    const ev = { type: 'tv-show', id, chatId, messageId: f.msg.id || null, index: f.index, chatTitle: c.title, question: String(question).slice(0, 400),
      text: f.msg.text, items: (f.msg.items || []).slice(0, 6).map(x => ({ title: x.title, year: x.year, imdb: x.imdb, platformName: x.platformName })),
      prev: prev ? { key: prev.key, name: prev.name } : null };
    pending = { ev, at: Date.now() }; last = { id, prev, at: Date.now() };
    send(Object.assign({}, ev));
    log('show on TV ' + id + (front ? ' (Home already in front)' : ' (opened Home via ' + via + (prev ? ', was ' + prev.name : '') + ')'));
    return [200, { ok: true, id, launcher: front ? 'front' : 'launched', via, previous: prev ? { key: prev.key, name: prev.name } : null, tvs: clientCount() }];
  }
  function shown(id) {
    if (pending && pending.ev.id === String(id || '')) { pending = null; return true; }
    return false;
  }
  async function back(id) {
    if (!last || last.id !== String(id || '') || Date.now() - last.at > BACK_MS) return [404, { ok: false, error: 'no-show' }];
    if (!last.prev) return [409, { ok: false, error: 'no-previous' }];
    const a = DOCK.load().apps.filter(x => x.key === last.prev.key)[0];
    if (!a) return [409, { ok: false, error: 'no-previous' }];
    try { const r = await tv.launch(a.appId, { noPair: true }); log('back to ' + a.name + ' (' + r.via + ')'); return [200, { ok: true, app: a.key, name: a.name, via: r.via }]; }
    catch (e) { return [503, { ok: false, error: e.code || 'launch-failed', app: a.key }]; }
  }
  // a launcher that connects to /events while a show is pending gets it right away
  function onClient(res) { const p = fresh(); if (p) { try { res.write('data: ' + JSON.stringify(Object.assign(payload(p), { ts: Date.now(), replay: true })) + '\n\n'); } catch (e) {} } }
  function current() { const p = fresh(); return p ? payload(p) : null; }
  return { show, shown, back, onClient, pending: current, get last() { return last; } };
}
module.exports = { create, isVisible, PENDING_MS };
