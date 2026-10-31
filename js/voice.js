/* Voice assistant overlay (Design B "Orb + Timeline").
 * Listens to the relay on your Mac (relay/server.js) over Server-Sent Events. The phone page is the microphone;
 * the TV shows what the assistant is doing (real steps + timings) and the answer with real posters/ratings.
 * If the relay can't be reached the feature stays completely hidden: no button, no hint, no fake UI.
 * Assistant name: Yo-Yo.
 * Keys: Play/Pause · Yo-Yo (or "v" in a browser) toggles the overlay · Back closes · ←/→/↑/↓ pick a result · OK opens its app
 *       · Info (or Yellow; "i" in a browser) expands the request stats card under the answer (collapsed by default).
 * v6.2: questions asked from the phone show in a small corner card instead (js/tvcard.js); Play/Pause still opens this view.
 * Config: RH_CONFIG.voice = { enabled, relay, card }   URL override: ?relay=http://host:8787   ?relay=off disables. */
(function () {
  'use strict';
  var CFG = (window.RH_CONFIG && window.RH_CONFIG.voice) || {};
  var qs = {}; location.search.replace(/[?&]([^=&]+)=?([^&]*)/g, function (m, k, v) { qs[k] = decodeURIComponent(v); });
  var RELAY = (qs.relay || CFG.relay || '').replace(/\/$/, '');
  var API = window.RH_Voice = { available: false, open: false, onKey: function () { return false; }, relay: RELAY, state: null };
  if (CFG.enabled === false || !RELAY || RELAY === 'off' || !window.EventSource) return;

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8, PLAYPAUSE: 10252, PLAY: 415, V: 86, INFO: 457, YELLOW: 405, I: 73 };
  var APPS = window.RH_APPS || {};
  var stats = null, statsOpen = false, statsT = null;
  var root = null, el = {}, steps = [], items = [], sel = 0, sess = null, t0 = 0, closeT = null, phase = 'idle', lastQuery = '';
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function secs(ms) { return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
  function runText(i) {
    if (i.kind === 'tv') return i.seasons ? i.seasons + (i.seasons === 1 ? ' season' : ' seasons') : (i.runtime ? i.runtime + ' min episodes' : 'Series');
    if (!i.runtime) return null;
    return i.runtime >= 60 ? Math.floor(i.runtime / 60) + 'h' + (i.runtime % 60 ? ' ' + (i.runtime % 60) + 'm' : '') : i.runtime + 'm';
  }

  function build() {
    if (root) return;
    root = document.createElement('div'); root.className = 'vx'; root.id = 'voice';
    root.innerHTML = '<div class="vx-scrim"></div><div class="vx-name">Yo-Yo</div><div class="vx-orb" id="vxOrb"><i></i></div><div class="vx-cap" id="vxCap"></div><div class="vx-q" id="vxQ"></div>' +
      '<div class="glass vx-tl" id="vxTl"><h3>What I\u2019m doing</h3><div id="vxSteps"></div></div>' +
      '<div class="glass vx-ap" id="vxAp"><h3>Answer<span id="vxBrain"></span></h3><div id="vxAns"></div></div>' +
      '<div class="vx-stats" id="vxStats"></div><div class="vx-sd" id="vxSd"></div>' +
      '<div class="vx-help" id="vxHelp"></div>';
    ($('stage') || document.body).appendChild(root);
    el = { orb: $('vxOrb'), cap: $('vxCap'), q: $('vxQ'), steps: $('vxSteps'), ans: $('vxAns'), brain: $('vxBrain'), tl: $('vxTl'), ap: $('vxAp'), help: $('vxHelp'), stats: $('vxStats'), sd: $('vxSd') };
    if (window.RH_Wallpaper && RH_Wallpaper.addGlass) { RH_Wallpaper.addGlass(el.tl); RH_Wallpaper.addGlass(el.ap); }
  }
  function cardMode() { return !API.open && !!(window.RH_VoiceCard && RH_VoiceCard.enabled); }
  function surface() { if (!cardMode()) show(); }   // v6.2: with the corner card (js/tvcard.js) the full overlay only opens on Play/Pause
  function show() {
    build();
    if (window.RH_VoiceCard && RH_VoiceCard.hideCard) RH_VoiceCard.hideCard();
    if (!API.open) {
      API.open = true; document.body.classList.add('voice-on'); root.classList.add('on');
      if (window.RH_Home && RH_Home.wake) RH_Home.wake();
      if (window.RH_Wallpaper && RH_Wallpaper.placeGlass) { RH_Wallpaper.placeGlass(el.tl); RH_Wallpaper.placeGlass(el.ap); }
    }
    armClose();
  }
  function hide() {
    if (!API.open) return;
    API.open = false; document.body.classList.remove('voice-on'); root.classList.remove('on');
    clearTimeout(closeT);
  }
  function armClose() { clearTimeout(closeT); closeT = setTimeout(hide, phase === 'done' ? 90000 : 120000); }   // never stays up forever
  function setPhase(p) {
    phase = p; API.state = p;
    root.className = 'vx' + (API.open ? ' on' : '') + ' vx-' + p;   // v6.2: phone questions may update it while closed (corner card mode)
    var total = 0; for (var i = 0; i < steps.length; i++) total += steps[i].ms || 0;   // steps run one after another
    el.cap.textContent = p === 'listening' ? 'Listening\u2026' : p === 'working' ? 'Working\u2026' : p === 'done' ? 'Done \u00b7 ' + secs(total) : p === 'error' ? 'Something went wrong' : 'Ask from your phone';
  }
  function renderSteps() {
    el.steps.innerHTML = steps.map(function (s) {
      return '<div class="vx-st ' + s.state + '"><i></i><b>' + esc(s.label) + '</b><span>' + esc(s.detail || (s.state === 'live' ? 'working\u2026' : '')) + '</span>' +
        (s.state === 'live' ? '<div class="vx-bar"><u></u></div>' : '') + (s.ms != null ? '<em>' + secs(s.ms) + '</em>' : '') + '</div>';
    }).join('');
  }
  // ---- request stats: one quiet line under the answer; Info expands a small card (per-step timings + token split) ----
  function kfmt(n) { return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }
  function statsLine(st) {
    var tok = st.tokens && st.tokens.total != null ? kfmt(st.tokens.total) + ' tokens' : 'no tokens';
    return [st.model, tok, secs(st.totalMs), st.tools + (st.tools === 1 ? ' tool' : ' tools')].concat(st.fallback ? [/daily AI limit/.test(st.fallback) ? 'daily AI limit reached' : /billing/.test(st.fallback) ? 'AI off (billing)' : 'fallback'] : []).join(' \u00b7 ');
  }
  function renderStats(st) {
    stats = st || null; statsOpen = false; clearTimeout(statsT);
    el.stats.className = 'vx-stats'; el.sd.className = 'vx-sd'; el.stats.textContent = ''; el.sd.innerHTML = '';
    if (!stats) return;
    el.stats.textContent = statsLine(stats);
    var t = stats.tokens && stats.tokens.total != null ? stats.tokens : null, tms = stats.toolMs || {}, tk = [];
    for (var n in tms) if (tms.hasOwnProperty(n)) tk.push(esc(n.replace(/_/g, ' ')) + ' ' + secs(tms[n]));
    el.sd.innerHTML = '<div class="vx-sd-h"><b>' + esc(stats.model) + '</b><span>' + (stats.llmCalls ? stats.llmCalls + ' LLM call' + (stats.llmCalls === 1 ? '' : 's') + ' \u00b7 ' + secs(stats.llmMs) : 'built-in parser') + '</span></div>' +
      '<div class="vx-sd-g"><div><em>' + (t ? kfmt(t.prompt) : '\u2013') + '</em>prompt</div><div><em>' + (t ? kfmt(t.completion) : '\u2013') + '</em>output</div><div><em>' + (stats.firstStepMs != null ? secs(stats.firstStepMs) : '\u2013') + '</em>first step</div><div><em>' + secs(stats.totalMs) + '</em>total</div></div>' +
      '<div class="vx-sd-s">' + (stats.steps || []).filter(function (x) { return x.label !== 'Heard you'; }).map(function (x) {
        return '<div><span>' + esc(x.label) + '</span><i style="width:' + Math.max(2, Math.round(160 * (x.ms || 0) / Math.max(1, stats.totalMs))) + 'px"></i><em>' + secs(x.ms || 0) + '</em></div>'; }).join('') + '</div>' +
      (tk.length ? '<div class="vx-sd-f">tools: ' + tk.join(' \u00b7 ') + '</div>' : '') + (stats.fallback ? '<div class="vx-sd-f warn">fallback: ' + esc(stats.fallback) + '</div>' : '');
    statsT = setTimeout(function () { el.stats.className = 'vx-stats in'; }, 700);   // after the answer has landed
  }
  function toggleStats(open) {
    if (!stats) return false;
    statsOpen = open == null ? !statsOpen : open;
    el.sd.className = 'vx-sd' + (statsOpen ? ' on' : ''); el.stats.className = 'vx-stats in' + (statsOpen ? ' open' : '');
    paintSel(); return true;
  }
  function renderAnswer(text, list, brain) {
    items = (list || []).slice(0, 4); sel = 0;
    el.brain.textContent = brain ? ' \u00b7 ' + brain : '';
    el.ans.innerHTML = '<div class="vx-ans">' + esc(text) + '</div>' + items.map(function (i, n) {
      var app = APPS[i.platform], meta = [i.year, runText(i), (i.genres || [])[0]].filter(Boolean).join(' \u00b7 ');
      return '<div class="vx-row" data-i="' + n + '"><div class="vx-art">' + (i.poster ? '<img src="' + esc(i.poster) + '" alt="">' : '<b>' + esc(i.title) + '</b>') + '</div>' +
        '<div class="vx-tx"><b>' + esc(i.title) + '</b><div>' + esc(meta) + '</div>' +
        (i.imdb ? '<span class="vx-badge imdb">IMDb ' + esc(i.imdb) + '</span>' : '') + (i.rt != null ? '<span class="vx-badge rt">RT ' + esc(i.rt) + '%</span>' : '') +
        (i.platformName ? '<span class="vx-plat">' + esc(i.platformName) + '</span>' : '') +
        '<div class="vx-go">' + (app ? 'OK \u00b7 open ' + esc(app.name) : '') + '</div></div></div>';
    }).join('');
    paintSel();
  }
  function renderSkeleton() {
    el.brain.textContent = ''; renderStats(null);
    el.ans.innerHTML = '<div class="vx-sk" style="width:90%"></div><div class="vx-sk" style="width:64%"></div>' +
      '<div class="vx-sk big"></div><div class="vx-sk big"></div>';
  }
  function paintSel() {
    var rows = el.ans.querySelectorAll('.vx-row');
    for (var i = 0; i < rows.length; i++) rows[i].className = 'vx-row' + (i === sel ? ' sel' : '');
    el.help.innerHTML = (items.length ? '<b>\u2190 \u2192</b> choose \u00b7 <b>OK</b> open \u00b7 <b>Back</b> close' : '<b>Back</b> close') + ' \u00b7 <b>Play/Pause</b> Yo-Yo' + (stats ? '<span class="vx-hi"> \u00b7 <b>Info</b> ' + (statsOpen ? 'hide stats' : 'stats') + '</span>' : '');
  }
  function reset(query) {
    build(); steps = []; items = []; sel = 0; t0 = Date.now(); lastQuery = query || '';
    el.q.textContent = query ? '\u201c' + query + '\u201d' : ''; renderSteps(); renderSkeleton();
  }

  function onEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'tv-show') { if (window.RH_VoiceCard) RH_VoiceCard.show(ev); return; }   // phone "Show on TV" (relay POST /tv/show)
    if (ev.session && sess && ev.session < sess) return;   // late events from a replaced request
    if (cardMode() && /^(listening|idle|transcript|start|step|answer|error|action)$/.test(ev.type)) RH_VoiceCard.event(ev);
    switch (ev.type) {
      case 'listening': surface(); if (phase !== 'working') { reset(''); setPhase('listening'); } return;
      case 'idle': if (API.open && phase === 'listening') hide(); return;
      case 'transcript': surface(); if (phase === 'listening' || phase === 'idle' || phase === 'done' || phase === 'error') { if (phase !== 'listening') { reset(''); setPhase('listening'); } }
        el.q.textContent = '\u201c' + ev.text + '\u201d'; el.q.className = 'vx-q' + (ev.final ? '' : ' interim'); return;
      case 'start': sess = ev.session; surface(); reset(ev.query); setPhase('working'); return;
      case 'step':
        if (ev.session !== sess) return;
        surface();
        var s = null; for (var i = 0; i < steps.length; i++) if (steps[i].id === ev.id) s = steps[i];
        if (ev.phase === 'start') { if (!s) steps.push({ id: ev.id, label: ev.label, state: 'live', start: ev.ts }); }
        else { if (!s) { s = { id: ev.id, label: ev.label }; steps.push(s); } s.state = ev.state === 'err' ? 'err' : 'ok'; s.detail = ev.detail; s.ms = ev.ms; s.end = ev.ts; }
        if (phase !== 'working') setPhase('working');
        renderSteps(); return;
      case 'answer': if (ev.session !== sess) return; surface(); renderStats(ev.stats); renderAnswer(ev.text, ev.items, ev.brain); setPhase('done'); armClose(); return;
      case 'error': if (ev.session !== sess) return; surface(); el.ans.innerHTML = '<div class="vx-ans">' + esc(ev.message) + '</div>'; items = []; paintSel(); setPhase('error'); return;
      case 'remote':   // phone remote app: launcher-only actions (POST /remote/launcher)
        if (ev.action === 'yoyo') { if (API.open) hide(); else openIdle(); }
        else if (ev.action === 'close') hide();
        else if (ev.action === 'stats' && API.open) toggleStats();
        return;
      case 'action':
        if (ev.session !== sess) return;
        setTimeout(function () {
          if (!window.RH_Home) return;
          if (ev.action === 'open_app') { hide(); RH_Home.launchApp(ev.app); }
          else if (ev.action === 'show_platform') { hide(); RH_Home.showPlatform(ev.app); }
        }, 1400);   // let the timeline show the step first
        return;
    }
  }

  function connect() {
    var es;
    try { es = new EventSource(RELAY + '/events'); } catch (e) { return; }
    API.es = es;
    es.onopen = function () { API.available = true; };
    es.onerror = function () { API.available = false; if (API.open && phase !== 'done') hide(); };   // EventSource retries by itself
    es.onmessage = function (m) { var ev; try { ev = JSON.parse(m.data); } catch (e) { return; } onEvent(ev); };
  }

  function openIdle() {
    show();
    if (phase === 'idle') { reset(''); setPhase('idle'); el.q.textContent = 'Open ' + RELAY.replace(/^https?:\/\//, '') + ' on your phone'; el.ans.innerHTML = '<div class="vx-ans">Hold the mic on your phone and ask for a show, a movie, ratings, the weather \u2014 or anything else.</div>'; paintSel(); }
    else { setPhase(phase); paintSel(); }
  }
  API.onKey = function (e) {
    var k = e.keyCode;
    var toggle = k === KEY.PLAYPAUSE || k === KEY.PLAY || (k === KEY.V && !window.RH_IS_TIZEN);
    if (!API.open && window.RH_VoiceCard && RH_VoiceCard.onKey(e)) return true;   // "Show on TV" panel / Back on the corner card
    if (!API.open) {
      if (toggle && API.available) {
        e.preventDefault(); openIdle();
        return true;
      }
      return false;
    }
    e.preventDefault(); armClose();
    if (k === KEY.INFO || k === KEY.YELLOW || (k === KEY.I && !window.RH_IS_TIZEN)) { toggleStats(); return true; }
    if (statsOpen && (k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE)) { toggleStats(false); return true; }   // Back collapses the card first
    if (toggle || k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE) { hide(); return true; }
    if (items.length && (k === KEY.RIGHT || k === KEY.DOWN)) { sel = Math.min(items.length - 1, sel + 1); paintSel(); return true; }
    if (items.length && (k === KEY.LEFT || k === KEY.UP)) { sel = Math.max(0, sel - 1); paintSel(); return true; }
    if (k === KEY.ENTER && items[sel] && items[sel].platform && APPS[items[sel].platform] && window.RH_Home) { var key = items[sel].platform; hide(); RH_Home.launchApp(key); return true; }
    return true;   // the overlay owns the remote while open
  };
  API._event = onEvent;   // tests
  API.close = hide;
  API.selected = function () { return sel; };
  API.steps = function () { return steps.slice(); };
  API.stats = function () { return { stats: stats, open: statsOpen, line: el.stats ? el.stats.textContent : '' }; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect); else connect();
})();
