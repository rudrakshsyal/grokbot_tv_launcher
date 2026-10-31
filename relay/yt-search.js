'use strict';
// v6.1 YouTube "search and play the top result", driven with the paired remote (real-device finding: the Tizen YouTube app
// answers 403 to DIAL without a YouTube Origin and ignores ed.apps.launch deep links, so a direct video id can't be relied on).
//   1. GET :8001/api/v2/applications/<id>: running / visible.
//   2. Not visible -> REST launch, wait. Not running before -> KEY_ENTER for the "Who's watching?" profile picker.
//   3. YT_SEARCH_KEYS opens Search (default LEFT = side nav, UP to the top item = Search, ENTER).
//   4. Type: if the TV reports the system keyboard (ms.remote.imeStart) -> SendInputString (base64) + SendInputEnd;
//      otherwise walk YouTube's own on-screen keyboard (YT_KEYBOARD grid) with arrow keys + ENTER per letter.
//      (YouTube normally uses its own keyboard, which never raises IME events; YT_TYPE=ime|grid forces one.)
//   5. YT_SUBMIT_KEYS runs the search, YT_PLAY_KEYS plays the first result.
// Every key list and wait comes from env so it can be tuned on the TV without code changes (tools/yt-search-probe.js).
const E = process.env;
const num = (k, d) => { const v = E[k]; return v === undefined || v === '' || isNaN(+v) ? d : +v; };
const DEFAULT_KEYBOARD = "abcdefg|hijklmn|opqrstu|vwxyz-'|___<<<<";

function cfg() {
  return {
    appId: E.YT_APP_ID || null,
    launchWait: num('YT_LAUNCH_WAIT_MS', 8000),     // cold start until the profile picker / home is up
    resumeWait: num('YT_RESUME_WAIT_MS', 2500),     // running in the background -> brought to front
    profileEnter: E.YT_PROFILE_ENTER !== '0',
    profileWait: num('YT_PROFILE_WAIT_MS', 4000),
    prefixKeys: E.YT_RUNNING_KEYS || '',            // only when YouTube was already running (e.g. "RETURN" to leave a playing video)
    searchKeys: E.YT_SEARCH_KEYS || 'LEFT,WAIT:600,UP*6,ENTER',
    searchWait: num('YT_SEARCH_WAIT_MS', 2000),
    keyGap: num('YT_KEY_GAP_MS', 350),
    type: (E.YT_TYPE || 'auto').toLowerCase(),     // auto | ime | grid | none
    imeWait: num('YT_IME_WAIT_MS', 1500),
    imeEnd: E.YT_IME_END !== '0',
    keyboard: E.YT_KEYBOARD || DEFAULT_KEYBOARD,
    kbStart: E.YT_KB_START || 'a',
    kbGap: num('YT_KB_GAP_MS', 220),
    kbMax: num('YT_KB_MAX_CHARS', 40),
    submitKeys: E.YT_SUBMIT_KEYS != null ? E.YT_SUBMIT_KEYS : 'RIGHT,ENTER',   // grid: first suggestion (= the typed text)
    submitImeKeys: E.YT_SUBMIT_IME_KEYS != null ? E.YT_SUBMIT_IME_KEYS : '',  // ime: SendInputEnd already submits
    resultsWait: num('YT_RESULTS_WAIT_MS', 3000),
    playKeys: E.YT_PLAY_KEYS != null ? E.YT_PLAY_KEYS : 'ENTER'
  };
}

// "LEFT,UP*6,ENTER,WAIT:500" -> [{key:'KEY_LEFT'}, {key:'KEY_UP'} x6, {key:'KEY_ENTER'}, {wait:500}]
function parseSeq(s) {
  const out = [];
  String(s || '').split(/[\s,]+/).filter(Boolean).forEach(tok => {
    const w = /^wait:?(\d+)$/i.exec(tok);
    if (w) return out.push({ wait: +w[1] });
    const m = /^(?:KEY_)?([A-Z_]+?)(?:\*(\d+))?$/i.exec(tok);
    if (!m) throw new Error('bad key token "' + tok + '"');
    const n = m[2] ? Math.min(+m[2], 40) : 1;
    for (let i = 0; i < n; i++) out.push({ key: 'KEY_' + m[1].toUpperCase() });
  });
  return out;
}

// Search text for an on-screen keyboard: no accents, lower case, only characters the layout has.
function normalize(text, layout) {
  const chars = new Set(String(layout).replace(/\|/g, '').split(''));
  let t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ');
  t = t.split('').map(ch => (ch === ' ' ? (chars.has('_') ? ' ' : '') : chars.has(ch) && ch !== '_' && ch !== '<' ? ch : ' ')).join('').replace(/\s+/g, ' ').trim();
  return t;
}
function cut(t, max) { if (t.length <= max) return t; const s = t.slice(0, max); const i = s.lastIndexOf(' '); return (i > max / 2 ? s.slice(0, i) : s).trim(); }

// Grid model: rows split by "|"; "_" = space key, "<" = delete; the same special char repeated = one wide key.
// Moving up/down keeps the column (snapped to the start of a wide key); left/right moves one key, no wrap-around.
function gridModel(layout) {
  const rows = String(layout).split('|').map(r => {
    const keys = []; for (let c = 0; c < r.length; c++) { const ch = r[c]; if ((ch === '_' || ch === '<') && keys.length && keys[keys.length - 1].ch === ch && keys[keys.length - 1].end === c - 1) keys[keys.length - 1].end = c; else keys.push({ ch, start: c, end: c }); }
    return keys;
  });
  const find = ch => { for (let r = 0; r < rows.length; r++) { const k = rows[r].findIndex(x => x.ch === ch); if (k >= 0) return { r, k }; } return null; };
  const keyAtCol = (r, col) => { const ks = rows[r]; for (let i = 0; i < ks.length; i++) if (col >= ks[i].start && col <= ks[i].end) return i; return col < ks[0].start ? 0 : ks.length - 1; };
  return { rows, find, keyAtCol };
}
// -> { keys:[KEY_*...], text } : arrow moves + KEY_ENTER per character
function gridKeys(text, layout, start) {
  const g = gridModel(layout), out = [];
  let pos = g.find(start || 'a') || { r: 0, k: 0 }, typed = '';
  for (const raw of text) {
    const ch = raw === ' ' ? '_' : raw, t = g.find(ch); if (!t) continue;
    while (pos.r !== t.r) { const col = g.rows[pos.r][pos.k].start, d = t.r > pos.r ? 1 : -1; pos = { r: pos.r + d, k: 0 }; pos.k = g.keyAtCol(pos.r, col); out.push(d > 0 ? 'KEY_DOWN' : 'KEY_UP'); }
    while (pos.k !== t.k) { const d = t.k > pos.k ? 1 : -1; pos.k += d; out.push(d > 0 ? 'KEY_RIGHT' : 'KEY_LEFT'); }
    out.push('KEY_ENTER'); typed += raw;
  }
  return { keys: out, text: typed };
}

// Build the whole plan up front (so the probe can print it and step through it).
function plan(query, st, o) {
  const c = cfg(), P = [];
  const wasRunning = !!(st && (st.running === true || String(st.running) === 'true'));
  const visible = !!(st && (st.visible === true || String(st.visible) === 'true'));
  if (!visible) { P.push({ step: 'launch', label: 'Open YouTube' }); P.push({ wait: wasRunning ? c.resumeWait : c.launchWait, label: 'wait for YouTube' }); }
  if (!wasRunning && c.profileEnter) { P.push({ key: 'KEY_ENTER', label: 'profile picker: OK on the highlighted profile' }); P.push({ wait: c.profileWait, label: 'wait for home' }); }
  if (wasRunning && c.prefixKeys) parseSeq(c.prefixKeys).forEach(x => P.push(Object.assign(x, { label: 'already running: ' + (x.key || 'wait') })));
  P.push({ step: 'ime-listen' });
  parseSeq(c.searchKeys).forEach(x => P.push(Object.assign(x, { label: 'open search: ' + (x.key || 'wait') })));
  P.push({ wait: c.searchWait, label: 'wait for the search screen' });
  P.push({ step: 'type', label: 'type the query' });
  P.push({ step: 'submit', label: 'run the search' });
  P.push({ wait: c.resultsWait, label: 'wait for results' });
  parseSeq(c.playKeys).forEach(x => P.push(Object.assign(x, { label: 'play the first result: ' + (x.key || 'wait') })));
  return { steps: P, wasRunning, visible, cfg: c };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// tv: TvRemote. o: { appId, log(line), beforeStep(step) (probe --step), launch(appId), cancel:{stop} }
async function run(tv, query, o) {
  o = o || {};
  const log = o.log || (() => {}), c = cfg(), appId = o.appId || c.appId || '9Ur5IzDKqV.TizenYouTube';
  const res = { ok: false, query, typed: null, method: null, ime: [], keys: 0, steps: [] };
  const note = s => { res.steps.push(s); log(s); };
  const onIme = (ev, data) => { res.ime.push({ ev, at: Date.now() }); log('  [ime] ' + ev + (data && typeof data === 'string' ? ' ' + data.slice(0, 40) : '')); };
  tv.on('ime', onIme);
  try {
    let st = null;
    try { st = await tv.appStatus(appId); } catch (e) { note('status: ' + e.message); }
    const p = plan(query, st, o);
    note('YouTube ' + (p.visible ? 'on screen' : p.wasRunning ? 'running in the background' : 'not running') + ' \u00b7 ' + p.steps.length + ' steps');
    res.wasRunning = p.wasRunning;
    let imeFrom = Infinity;
    const live = () => { if (o.cancel && o.cancel.stop) throw Object.assign(new Error('cancelled by a newer request'), { code: 'cancelled' }); };
    for (const s of p.steps) {
      live();
      if (o.beforeStep) await o.beforeStep(s);
      if (s.wait != null) { if (s.label) log('  wait ' + s.wait + ' ms (' + s.label + ')'); await sleep(s.wait); continue; }
      if (s.key) { await tv.key(s.key); res.keys++; log('  key ' + s.key + (s.label ? '  \u00b7 ' + s.label : '')); await sleep(c.keyGap); continue; }
      if (s.step === 'launch') { await (o.launch ? o.launch(appId) : tv.launch(appId, { noPair: true })); note('launched ' + appId); continue; }
      if (s.step === 'ime-listen') { imeFrom = Date.now(); continue; }
      if (s.step === 'type') {
        let method = c.type;
        if (method === 'auto') {
          const t0 = Date.now(); while (!res.ime.some(x => x.at >= imeFrom && /imeStart/.test(x.ev)) && Date.now() - t0 < c.imeWait) await sleep(50);
          method = res.ime.some(x => x.at >= imeFrom && /imeStart/.test(x.ev)) ? 'ime' : 'grid';
        }
        res.method = method;
        if (method === 'ime') {
          const text = cut(String(query).replace(/\s+/g, ' ').trim(), 100);
          await tv.inputString(text); res.typed = text; note('typed via the TV keyboard (SendInputString): "' + text + '"');
          if (c.imeEnd) { await sleep(300); await tv.inputEnd(); log('  SendInputEnd'); }
        } else if (method === 'grid') {
          const text = cut(normalize(query, c.keyboard), c.kbMax), g = gridKeys(text, c.keyboard, c.kbStart);
          note('typing "' + g.text + '" on YouTube\u2019s keyboard (' + g.keys.length + ' key presses)');
          for (const k of g.keys) { live(); await tv.key(k); res.keys++; await sleep(c.kbGap); }
          res.typed = g.text;
        } else note('typing skipped (YT_TYPE=' + method + ')');
        continue;
      }
      if (s.step === 'submit') {
        const seq = parseSeq(res.method === 'ime' ? c.submitImeKeys : c.submitKeys);
        for (const x of seq) { if (x.wait != null) await sleep(x.wait); else { await tv.key(x.key); res.keys++; log('  key ' + x.key + '  \u00b7 run the search'); await sleep(c.keyGap); } }
        continue;
      }
    }
    res.ok = true; note('done: ' + res.keys + ' keys, typed via ' + res.method);
  } catch (e) { res.error = e.message; res.code = e.code; note('failed: ' + e.message); }
  finally { tv.removeListener('ime', onIme); }
  return res;
}
module.exports = { run, plan, parseSeq, normalize, gridKeys, gridModel, cfg, DEFAULT_KEYBOARD };
