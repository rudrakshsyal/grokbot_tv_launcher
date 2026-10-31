/* v6.2 Yo-Yo on the TV without taking it over (driven by js/voice.js events from the relay).
 *  1. Corner card: when you ask Yo-Yo from the phone (/ask, typed or voice) and the launcher is on screen, a small glass
 *     card in the bottom-right corner shows the question (one line), a small orb (listening / thinking / answering) and the
 *     answer. It never takes focus: arrows/OK keep driving the home screen; only Back is used (to dismiss it).
 *     It fades ~8 s after the answer (longer answers stay a little longer). Launcher not visible -> nothing happens.
 *  2. "Show on TV" panel: the phone's button -> POST /tv/show on the relay -> the relay brings this launcher to the front and
 *     pushes { type: 'tv-show' }. A centered glass panel shows the whole answer: Up/Down scroll, Back closes,
 *     OK = "Back to <app>" when the relay saw another app on screen (relaunched through the relay: POST /tv/back).
 * Config: RH_CONFIG.voice.card = false (or ?vcard=0) restores the v6.1 behaviour (phone questions open the full overlay).
 * Chromium-76 safe (no ?. / ??). */
(function () {
  'use strict';
  var CFG = (window.RH_CONFIG && window.RH_CONFIG.voice) || {};
  var qs = {}; location.search.replace(/[?&]([^=&]+)=?([^&]*)/g, function (m, k, v) { qs[k] = decodeURIComponent(v); });
  var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8, PLAYPAUSE: 10252, PLAY: 415, V: 86, PGUP: 33, PGDN: 34 };
  var STALE_MS = 12000, RESUME_GRACE_MS = 700, SCROLL_STEP = 200;
  var C = { el: null, on: false, state: 'idle', q: '', text: '', session: null, fadeT: null, revealT: null, placeT: null };
  var P = { el: null, on: false, ev: null, y: 0, max: 0, shown: {}, waiting: null };
  var skew = null, resumedAt = 0;
  var API = window.RH_VoiceCard = {
    enabled: CFG.card !== false && qs.vcard !== '0',
    get visible() { return C.on; }, get panelOpen() { return P.on; }, get busy() { return C.on || P.on; },
    get state() { return C.state; }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function relay() { return (window.RH_Voice && RH_Voice.relay) || ''; }
  function stage() { return $('stage') || document.body; }
  function glass(el) { if (window.RH_Wallpaper && RH_Wallpaper.addGlass) RH_Wallpaper.addGlass(el); }
  function placeGlass(el) { if (window.RH_Wallpaper && RH_Wallpaper.placeGlass) RH_Wallpaper.placeGlass(el); }
  function plain(t) {   // card: one paragraph, no markdown symbols
    return String(t || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s*[-*\u2022]\s+/gm, '').replace(/^#+\s*/gm, '').replace(/[*_`]/g, '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  function rich(t) {    // panel: paragraphs, bullets, **bold**
    var out = [], list = null;
    String(t || '').replace(/\r/g, '').split('\n').forEach(function (line) {
      var l = line.trim(), m = /^(?:[-*\u2022]|\d+[.)])\s+(.*)$/.exec(l);
      var h = function (s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1<i>$2</i>'); };
      if (m) { if (!list) { list = []; } list.push('<li>' + h(m[1]) + '</li>'); return; }
      if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; }
      if (!l) return;
      out.push('<p>' + h(l.replace(/^#+\s*/, '')) + '</p>');
    });
    if (list) out.push('<ul>' + list.join('') + '</ul>');
    return out.join('');
  }
  // events buffered while the app was suspended (Netflix in front) arrive in a burst on resume: never replay them
  function stale(ev) {
    if (Date.now() - resumedAt < RESUME_GRACE_MS) return true;
    if (!ev || !ev.ts) return false;
    var d = Date.now() - ev.ts; if (skew === null || d < skew) skew = d;   // relay/TV clock offset + latency (smallest seen)
    return d - skew > STALE_MS;
  }

  /* ---------------- corner card ---------------- */
  function buildCard() {
    if (C.el) return;
    var el = C.el = document.createElement('div'); el.className = 'yc glass'; el.id = 'yoyoCard';
    el.innerHTML = '<div class="yc-h"><span class="yc-orb" id="ycOrb"><i></i></span><b>Yo-Yo</b><span class="yc-st" id="ycSt"></span></div>' +
      '<div class="yc-q" id="ycQ"></div><div class="yc-a" id="ycA"></div><div class="yc-f" id="ycF"></div>';
    stage().appendChild(el); glass(el);
  }
  var STATE_TEXT = { listening: 'Listening\u2026', thinking: 'Thinking\u2026', answering: 'Answering', done: 'Answered', error: 'Couldn\u2019t answer' };
  function paintCard() {
    C.el.className = 'yc glass on yc-' + C.state;
    $('ycSt').textContent = STATE_TEXT[C.state] || '';
    $('ycQ').textContent = C.q ? '\u201c' + C.q + '\u201d' : '';
    $('ycQ').className = 'yc-q' + (C.interim ? ' interim' : '');
    $('ycF').innerHTML = C.state === 'done' || C.state === 'error' ? '<b>Back</b> dismiss' + (C.cut ? ' \u00b7 full answer: <b>Show on TV</b> on your phone' : '') : '';
    clearTimeout(C.placeT); C.placeT = setTimeout(function () { placeGlass(C.el); }, 0);   // the card grows upwards: re-clip the baked glass
  }
  function showCard() {
    buildCard();
    if (!C.on) {
      C.on = true;
      if (window.RH_Home && RH_Home.wake) RH_Home.wake();   // out of the screensaver / idle dim, like the full overlay
    }
    clearTimeout(C.fadeT); C.fadeT = setTimeout(hideCard, 120000);   // never stays up forever
  }
  function hideCard() {
    clearTimeout(C.fadeT); clearInterval(C.revealT); C.revealT = null;
    if (!C.on) return;
    C.on = false; C.state = 'idle'; C.el.className = 'yc glass yc-out';
  }
  function setAnswerText(t) { var a = $('ycA'); a.textContent = t; C.cut = a.scrollHeight > a.clientHeight + 4; }
  function fadeAfter(len) { clearTimeout(C.fadeT); C.fadeT = setTimeout(hideCard, Math.min(20000, 8000 + Math.max(0, len - 80) * 30)); }
  function reveal(text, done) {   // the relay sends the whole answer at once: type it in quickly so "answering" reads as live
    clearInterval(C.revealT);
    var words = text.split(' '), n = 0, total = Math.min(1400, 240 + words.length * 22), per = Math.max(1, Math.ceil(words.length / (total / 50)));
    C.revealT = setInterval(function () {
      n = Math.min(words.length, n + per); $('ycA').textContent = words.slice(0, n).join(' ');
      if (n >= words.length) { clearInterval(C.revealT); C.revealT = null; done(); }
    }, 50);
  }
  // events from voice.js while the full overlay is closed. Returns true when the card handled it.
  API.event = function (ev) {
    if (!API.enabled || !ev) return false;
    if (document.hidden || P.on || stale(ev)) return true;   // not on screen / the big panel is up: nothing on the TV
    switch (ev.type) {
      case 'listening': showCard(); if (C.state !== 'thinking' && C.state !== 'answering') { C.state = 'listening'; C.q = ''; C.interim = false; setAnswerText(''); } paintCard(); return true;
      case 'idle': if (C.on && C.state === 'listening') hideCard(); return true;
      case 'transcript': showCard(); if (C.state !== 'thinking' && C.state !== 'answering') { C.state = 'listening'; setAnswerText(''); }
        C.q = ev.text || ''; C.interim = !ev.final; paintCard(); return true;
      case 'start': showCard(); C.session = ev.session; C.state = 'thinking'; C.q = ev.query || C.q; C.interim = false; clearInterval(C.revealT); setAnswerText(''); paintCard(); return true;
      case 'step': if (!C.on || ev.session !== C.session) return true;
        if (ev.phase === 'start' && C.state === 'thinking' && ev.label) { $('ycA').innerHTML = '<span class="yc-step">' + esc(ev.label) + '\u2026</span>'; C.cut = false; }
        return true;
      case 'answer': if (ev.session !== C.session && C.session != null) return true;
        showCard(); C.state = 'answering'; var t = plain(ev.text) || 'Done.'; C.text = t; setAnswerText(''); paintCard();
        reveal(t, function () { setAnswerText(t); C.state = 'done'; paintCard(); fadeAfter(t.length); });
        return true;
      case 'error': if (ev.superseded || (ev.session !== C.session && C.session != null)) return true;
        showCard(); C.state = 'error'; setAnswerText(ev.message || 'Something went wrong.'); paintCard(); fadeAfter(0); clearTimeout(C.fadeT); C.fadeT = setTimeout(hideCard, 6000);
        return true;
      case 'action': if (ev.action === 'open_app') setTimeout(hideCard, 1400); return true;   // the app is about to open
    }
    return false;
  };
  API.hideCard = hideCard;

  /* ---------------- "Show on TV" panel ---------------- */
  function buildPanel() {
    if (P.el) return;
    var el = P.el = document.createElement('div'); el.className = 'yp'; el.id = 'yoyoPanel';
    el.innerHTML = '<div class="yp-scrim"></div><div class="yp-box glass" id="ypBox">' +
      '<div class="yp-h"><span class="yc-orb"><i></i></span><b>Yo-Yo</b><span id="ypChat"></span></div>' +
      '<div class="yp-q" id="ypQ"></div>' +
      '<div class="yp-view" id="ypView"><div class="yp-body" id="ypBody"></div></div>' +
      '<div class="yp-bar" id="ypBar"><i id="ypThumb"></i></div>' +
      '<div class="yp-f"><span class="yp-help" id="ypHelp"></span><span class="yp-back" id="ypBack"></span></div></div>';
    stage().appendChild(el); glass($('ypBox'));
  }
  function scrollTo(y) {
    P.y = Math.max(0, Math.min(P.max, y));
    $('ypBody').style.transform = 'translate3d(0,' + (-P.y) + 'px,0)';
    var view = $('ypView').clientHeight, h = view + P.max, th = Math.max(40, Math.round(view * view / h));
    $('ypBar').style.display = P.max > 0 ? '' : 'none';
    $('ypThumb').style.height = th + 'px';
    $('ypThumb').style.transform = 'translate3d(0,' + (P.max ? Math.round((view - th) * P.y / P.max) : 0) + 'px,0)';
    $('ypView').className = 'yp-view' + (P.y > 0 ? ' top' : '') + (P.y < P.max ? ' more' : '');
  }
  function paintHelp() {
    $('ypHelp').innerHTML = (P.max > 0 ? '<b>\u2191 \u2193</b> scroll \u00b7 ' : '') + '<b>Back</b> close';
    var pv = P.ev && P.ev.prev;
    $('ypBack').innerHTML = pv ? '<b>OK</b> Back to ' + esc(pv.name) : '';
    $('ypBack').style.display = pv ? '' : 'none';
  }
  function showPanel(ev) {
    buildPanel(); hideCard();
    if (window.RH_Voice && RH_Voice.open && RH_Voice.close) RH_Voice.close();
    P.ev = ev; P.shown[ev.id] = 1; P.on = true;
    $('ypChat').textContent = ev.chatTitle ? '\u00b7 ' + ev.chatTitle : '';
    $('ypQ').textContent = ev.question ? '\u201c' + ev.question + '\u201d' : '';
    var its = (ev.items || []).filter(function (x) { return x && x.title; });
    $('ypBody').innerHTML = rich(ev.text) + (its.length ? '<div class="yp-its">' + its.map(function (x) {
      return '<span>' + esc(x.title) + (x.year ? ' (' + esc(x.year) + ')' : '') + (x.imdb ? ' \u00b7 IMDb ' + esc(x.imdb) : '') + (x.platformName ? ' \u00b7 ' + esc(x.platformName) : '') + '</span>'; }).join('') + '</div>' : '');
    P.el.className = 'yp on';
    document.body.classList.add('yp-on');
    if (window.RH_Home && RH_Home.wake) RH_Home.wake();
    P.max = Math.max(0, $('ypBody').scrollHeight - $('ypView').clientHeight);
    scrollTo(0); paintHelp(); placeGlass($('ypBox'));
    ack(ev.id);
  }
  function hidePanel() {
    if (!P.on) return;
    P.on = false; P.el.className = 'yp'; document.body.classList.remove('yp-on');
  }
  function xhr(method, path, body, cb) {   // text/plain POST: a "simple" request, no CORS preflight (the relay refuses those on /tv/)
    if (!relay()) return cb && cb(null);
    try {
      var x = new XMLHttpRequest(); x.open(method, relay() + path, true); x.timeout = 8000;
      if (body) x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} if (cb) cb(x.status === 200 ? j : null, x.status); };
      x.onerror = x.ontimeout = function () { if (cb) cb(null, 0); };
      x.send(body ? JSON.stringify(body) : null);
    } catch (e) { if (cb) cb(null, 0); }
  }
  function ack(id) { xhr('POST', '/tv/shown', { id: id }); }
  function backToPrev() {
    var ev = P.ev, pv = ev && ev.prev; if (!pv) return;
    hidePanel();
    xhr('POST', '/tv/back', { id: ev.id }, function (j) {
      if (j && j.ok) return;
      if (window.RH_Home && RH_Home.launchApp) RH_Home.launchApp(pv.key);   // relay unreachable: open it from here instead
    });
  }
  API.show = function (ev) {   // { type: 'tv-show', id, question, text, prev, ... }
    if (!ev || !ev.id || P.shown[ev.id]) return;
    if (document.hidden) { P.waiting = { ev: ev, at: Date.now() }; return; }   // still coming to the front: show on resume
    showPanel(ev);
  };
  function checkPending() {
    if (P.waiting && Date.now() - P.waiting.at < 60000) { var w = P.waiting.ev; P.waiting = null; if (!P.shown[w.id]) showPanel(w); return; }
    P.waiting = null;
    xhr('GET', '/tv/pending', null, function (j) { if (j && j.pending && j.pending.id && !P.shown[j.pending.id] && !document.hidden) showPanel(j.pending); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hideCard(); return; }
    resumedAt = Date.now(); checkPending();
  });

  /* ---------------- keys (called first from RH_Voice.onKey while the full overlay is closed) ---------------- */
  API.onKey = function (e) {
    var k = e.keyCode, back = k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE;
    var toggle = k === KEY.PLAYPAUSE || k === KEY.PLAY || (k === KEY.V && !window.RH_IS_TIZEN);
    if (P.on) {
      if (toggle) { hidePanel(); return false; }          // Play/Pause: close the panel and let Yo-Yo open as usual
      e.preventDefault();
      if (back) { hidePanel(); return true; }
      if (k === KEY.DOWN || k === KEY.PGDN) { scrollTo(P.y + SCROLL_STEP); return true; }
      if (k === KEY.UP || k === KEY.PGUP) { scrollTo(P.y - SCROLL_STEP); return true; }
      if (k === KEY.ENTER && !e.repeat) { if (P.ev && P.ev.prev) backToPrev(); return true; }
      return true;                                           // the panel owns the remote while open
    }
    if (C.on) {
      if (back) { e.preventDefault(); hideCard(); return true; }
      if (toggle) { hideCard(); return false; }               // Play/Pause opens the full Yo-Yo view (timeline + posters)
    }
    return false;                                            // arrows / OK keep driving the home screen
  };
  API._panel = function () { return { on: P.on, y: P.y, max: P.max, id: P.ev && P.ev.id, prev: P.ev && P.ev.prev }; };   // tests
  API._reset = function () { skew = null; resumedAt = 0; };
})();
