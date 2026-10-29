/* Glass Home launcher — UI, focus engine, Ambient/Discover states, launching, keys.
 * Responsiveness rules: every keydown is handled synchronously (no debounce, no queued animation); focus changes
 * only toggle classes whose transitions are transform/opacity (140 ms); no layout reads on the key path except
 * cached item centres; persistence writes are deferred. Chromium-76 safe. */
(function () {
  'use strict';
  var CFG = window.RH_CONFIG, APPS = window.RH_APPS, DSC = window.RH_Discover;
  var IS_TIZEN = window.RH_IS_TIZEN;
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var params = (function () {
    var o = {}; location.search.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return; var p = kv.split('='); o[decodeURIComponent(p[0])] = p.length > 1 ? decodeURIComponent(p[1]) : '1';
    }); return o;
  })();
  function log() { if (CFG.debug && window.console) console.log.apply(console, ['[home]'].concat([].slice.call(arguments))); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function later(fn) { if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 1500 }); else setTimeout(fn, 200); }

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    ESC: 27, BACKSPACE: 8 };

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast glass-chip show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast glass-chip'; }, ms || 2200);
  }
  window.RH_toast = toast;

  /* ---------------- stage scaling (desktop preview only) ---------------- */
  function fitStage() {
    var s = $('stage');
    if (IS_TIZEN) { s.style.transform = ''; return; }
    var k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    s.style.transform = k === 1 ? '' : 'scale(' + k + ')';
    resetCenters();
    if (window.RH_Wallpaper && RH_Wallpaper.placeGlass && !discoverOn) RH_Wallpaper.placeGlass();
  }

  /* ---------------- clock & greeting ---------------- */
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var clockTimer = null, clockEl = null;
  function tick() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes(), mm = (m < 10 ? '0' : '') + m;
    if (CFG.ui.clock24h) $('time').innerHTML = (h < 10 ? '0' : '') + h + ':' + mm;
    else $('time').innerHTML = ((h % 12) || 12) + ':' + mm + '<small>' + (h < 12 ? 'AM' : 'PM') + '</small>';
    $('date').textContent = DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
    $('ambTime').innerHTML = $('time').innerHTML; $('ambDate').textContent = $('date').textContent;
    if (CFG.ui.greeting) {
      var g = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
      $('greet').textContent = g + (CFG.ui.userName ? ', ' + CFG.ui.userName : '');
    }
    if (DSC) $('dscSub').textContent = DSC.subline(DSC.context(d));
    if (clockEl && window.RH_Wallpaper && RH_Wallpaper.placeGlass) RH_Wallpaper.placeGlass(clockEl);  // width changes with the time
    clearTimeout(clockTimer);
    clockTimer = setTimeout(tick, (60 - d.getSeconds()) * 1000 - d.getMilliseconds() + 30);
  }

  /* ---------------- rows ---------------- */
  // y = vertical order on screen. info(0) · cw(1) · platform(1.8) · tabs(1.9) · picks(2) · acts(2.5) · dock(3) · inputs(3.5)
  var rows = [];
  var focus = { r: 0, i: 0 };
  var dockRow = null, inputsRow = null, infoRow = null, traktRow = null, cwRow = null, platRow = null, refreshRow = null, picksRow = null, actsRow = null;
  var discoverOn = false;

  function hexToRgba(hex, a) {
    var h = hex.replace('#', ''); if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
    var n = parseInt(h, 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function brandVars(app) { return '--brand:' + hexToRgba(app.color, 0.85) + ';--brandA:' + hexToRgba(app.color, 0.36); }
  function logoHTML(key) {
    var img = window.RH_LOGO_IMAGES && window.RH_LOGO_IMAGES[key];
    if (img) return '<img class="mk-img" src="' + img + '" alt="">';
    return (window.RH_LOGOS && window.RH_LOGOS[key]) || '<div class="mk">' + APPS[key].name + '</div>';
  }
  function tileHTML(key, size) {
    var app = APPS[key]; if (!app) return '';
    return '<div class="tile tile-' + size + '" data-app="' + key + '" style="' + brandVars(app) + '">' +
      '<div class="tile-body"><div class="tile-tint"></div></div><div class="tile-fx"></div>' +
      '<div class="tile-logo">' + logoHTML(key) + '</div>' +
      '<div class="tile-label">' + app.name + '</div></div>';
  }
  function mkRow(o) { o.offset = 0; o.items = o.items || []; o.data = o.data || []; rows.push(o); return o; }
  function buildDock() {
    var D = CFG.dock || {}, main = D.main || [], extra = D.extra || [];
    var row = document.createElement('section');
    row.className = 'row row-dock';
    var html = '<div class="dock"><div class="dock-title">All Apps</div><div class="dock-bg glass" id="dockBg"></div><div class="row-track">';
    main.forEach(function (k) { html += tileHTML(k, 'lg'); });
    if (main.length && extra.length) html += '<div class="dock-div"></div>';
    extra.forEach(function (k) { html += tileHTML(k, 'sm'); });
    row.innerHTML = html + '</div><div class="dock-in" id="dockIn"></div></div>';
    $('rows').appendChild(row);
    var items = [].slice.call(row.querySelectorAll('.tile'));
    dockRow = mkRow({ el: row, kind: 'apps', items: items, data: items.map(function (el) { return el.getAttribute('data-app'); }), y: 3 });
    inputsRow = mkRow({ el: $('dockIn'), kind: 'inputs', y: 3.5 });
  }
  /* Inputs row under the dock apps (js/inputs.js): only HDMI ports the TV reports (connected ones when it says so), plus
   * a TV Settings chip. Nothing at all in the desktop preview, except the labelled ?inputs=mock used by tools/preview. */
  var HDMI_IC = '<svg class="in-ic" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M3 8.5h18v4.2l-2.2 2.8H5.2L3 12.7z"/><path stroke="currentColor" stroke-width="1.5" d="M7 11h10"/></svg>';
  var GEAR_IC = '<svg class="in-ic" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M10.3 3h3.4l.5 2.4 1.7.9 2.3-.9 1.7 2.9-1.8 1.6v2.2l1.8 1.6-1.7 2.9-2.3-.9-1.7.9-.5 2.4h-3.4l-.5-2.4-1.7-.9-2.3.9-1.7-2.9 1.8-1.6v-2.2L4.1 8.3l1.7-2.9 2.3.9 1.7-.9z"/></svg>';
  function renderInputs(res) {
    if (!inputsRow) return;
    var ports = (res && res.ports) || [], data = [], html = '';
    if (res && res.state === 'mock') html += '<div class="in-mock">Preview \u00b7 mock inputs</div>';
    ports.forEach(function (p) {
      data.push({ type: 'port', port: p });
      html += '<div class="in-chip" data-k="' + esc(p.key) + '"><div class="in-bg"></div>' + HDMI_IC + '<span class="in-t">' + esc(p.title) + '</span>' +
        (p.sub ? '<span class="in-s">' + esc(p.sub) + '</span>' : '') + '</div>';
    });
    if (window.RH_Inputs && RH_Inputs.settingsAvailable() && (CFG.inputs || {}).settings !== false) { data.push({ type: 'settings' }); html += '<div class="in-chip in-set"><div class="in-bg"></div>' + GEAR_IC + '<span class="in-t">Settings</span></div>'; }
    if (data.length && ports.length) html = '<div class="in-lab">Inputs</div>' + html;
    var onRow = rows[focus.r] === inputsRow, fi = focus.i;
    inputsRow.el.innerHTML = html;
    inputsRow.items = [].slice.call(inputsRow.el.querySelectorAll('.in-chip'));
    inputsRow.data = data;
    body.classList.toggle('has-inputs', data.length > 0);
    if (onRow) { if (data.length) setFocus(rows.indexOf(inputsRow), Math.min(fi, data.length - 1), true); else setFocus(rows.indexOf(dockRow), lastDockI, true); }
    resetCenters();
    if (window.RH_Wallpaper && RH_Wallpaper.placeGlass && dockOn) RH_Wallpaper.placeGlass($('dockBg'));
  }
  function startInputs() {
    if (!window.RH_Inputs || (CFG.inputs || {}).enabled === false || params.inputs === '0') return;
    RH_Inputs.detect(renderInputs);
    RH_Inputs.watch(renderInputs);
  }
  function activateInput(d) {
    if (!d) return;
    var cb = function (ok, msg) { if (!ok && msg) toast(msg, 3000); };
    if (d.type === 'settings') return RH_Inputs.openSettings(cb);
    RH_Inputs.select(d.port, cb);
  }
  /* Small "i" next to the location caption: photo credit on demand (also Yellow key). */
  function buildInfo() {
    var el = $('wpinfo'); if (!el || !window.RH_Wallpaper || !(CFG.wallpaper || {}).enabled) return;
    infoRow = mkRow({ el: el, kind: 'info', items: [el], data: ['info'], y: 0 });
  }
  var creditTimer = null;
  function toggleCredit(force) {
    var on = force === undefined ? !body.classList.contains('show-credit') : !!force;
    body.classList.toggle('show-credit', on);
    clearTimeout(creditTimer);
    if (on && !(CFG.wallpaper || {}).showCredit) creditTimer = setTimeout(function () { toggleCredit(false); }, 15000);
  }

  /* ---------------- Discover: Continue Watching + Tonight's Picks ---------------- */
  var picksState = { mode: 'none', picks: [] }, cwItems = [];
  function buildDiscover() {
    traktRow = mkRow({ kind: 'trakt', y: 0.8 });
    cwRow = mkRow({ kind: 'cw', y: 1 });
    platRow = mkRow({ kind: 'plat', y: 1.8, items: [], data: [] });     // ‹ Netflix › — Left/Right slides to the next service
    refreshRow = mkRow({ kind: 'tabs', y: 1.9, items: [], data: [] });   // Movies | Shows (| Refresh in the no-platform fallback)
    paintPlat();
    paintTabs();
    picksRow = mkRow({ kind: 'picks', y: 2 });
    actsRow = mkRow({ kind: 'acts', y: 2.5 });
  }
  /* Movies | Shows: weekends lean movies, weeknights shows (same idea as the 'tonight' score); remembered for the session. */
  var tab = (function () { var c = DSC && DSC.context ? DSC.context(new Date()) : {}; return params.tab === 'movie' || params.tab === 'tv' ? params.tab : c.weekend ? 'movie' : 'tv'; })();
  function paintTabs() {
    $('tabMovie').className = 'tab' + (tab === 'movie' ? ' on' : ''); $('tabTv').className = 'tab' + (tab === 'tv' ? ' on' : '');
    if (rows[focus.r] === refreshRow) cur().classList.add('is-focused');
  }
  function switchTab(k) {
    if (k !== 'movie' && k !== 'tv' || k === tab) return;
    tab = k; paintTabs(); loadPicks({});
  }
  /* ---------- platform carousel: one streaming service per page (live data only) ---------- */
  var plats = DSC && DSC.platforms ? DSC.platforms() : [], platI = 0, platShown = false;
  if (params.plat && plats.indexOf(params.plat) >= 0) platI = plats.indexOf(params.plat);
  function platMode() { return plats.length > 0; }
  function platKey() { return plats[platI]; }
  function paintPlat() {
    if (!platRow) return;
    var on = platMode();
    $('picks').classList.toggle('has-plat', on);
    platRow.items = on ? [$('plat')] : []; platRow.data = on ? [platKey()] : [];
    if (!on) return;
    var key = platKey(), app = APPS[key];
    $('platLogo').innerHTML = logoHTML(key);
    $('plat').setAttribute('style', brandVars(app));
    $('platName').textContent = app.name;
    $('platDots').innerHTML = plats.map(function (k, i) { return '<i' + (i === platI ? ' class="on"' : '') + '></i>'; }).join('');
  }
  var slideDir = 0, ghostTimer = null;
  function reduceMotion() { return body.classList.contains('reduce-motion'); }
  /* Carousel: the old page is cloned into a ghost that slides/fades out while the new one slides in (transform + opacity
   * only, ~300 ms). A new press mid-slide drops the old ghost at once, so rapid presses never queue. */
  function slideOut(d) {
    var old = $('pkStage').querySelector('.pk-ghost'); if (old) old.parentNode.removeChild(old);
    clearTimeout(ghostTimer);
    if (reduceMotion()) return;
    var g = $('pkTrack').cloneNode(true); g.removeAttribute('id'); g.className = 'pk-track pk-ghost';
    [].forEach.call(g.querySelectorAll('.is-focused, .act-open'), function (e) { e.classList.remove('is-focused'); e.classList.remove('act-open'); });
    $('pkStage').appendChild(g);
    void g.offsetWidth;
    g.className = 'pk-track pk-ghost ' + (d > 0 ? 'go-l' : 'go-r');
    ghostTimer = setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 340);
    slideDir = d;
  }
  function slideIn(el, d) {
    if (!d || reduceMotion()) return;
    el.classList.remove('slide-in'); el.classList.add(d > 0 ? 'from-r' : 'from-l');
    void el.offsetWidth;
    el.classList.add('slide-in'); el.classList.remove('from-r'); el.classList.remove('from-l');
  }
  function switchPlatform(d, land) {
    if (!platMode() || plats.length < 2) return;
    platI = (platI + d + plats.length) % plats.length;
    pendingPicks = null;
    slideOut(d); paintPlat(); slideIn($('plat'), d);
    var r = rows[focus.r], inPicks = r === picksRow || r === actsRow;
    loadPicks({ keepIdx: land === 'last' ? 2 : 0, platSwitch: true, focusPicks: inPicks });
  }
  function appName(k) { return k && APPS[k] ? APPS[k].name : null; }
  function fmtDate(iso) { var d = new Date(iso); return isNaN(d) ? '' : MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ', ' + d.getFullYear(); }
  function runtimeText(t) {
    var m = t.runtimeMin; if (!m) return null;
    if (t.kind === 'tv') return m + ' min episodes';
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '') : m + ' min';
  }
  var traktFlow = null;   // { code, url } while the device-code flow is waiting
  /* One honest line about Trakt: 'Trakt linked · …' / 'Trakt not linked'. Focusable (Enter = link on the TV) only when not linked. */
  function renderTraktStatus() {
    var el = $('tstat'); if (!el || !DSC) return;
    var inf = DSC.mock ? { state: 'mock' } : DSC.trakt.info(), txt = '', act = '';
    if (traktFlow) { txt = 'Trakt: enter ' + traktFlow.code + ' at ' + traktFlow.url + ' \u00b7 waiting\u2026'; }
    else if (inf.state === 'linked') {
      var n = cwItems.length, h = DSC.trakt.historyCount();
      txt = 'Trakt linked' + (inf.user ? ' (' + inf.user + ')' : '') + ' \u00b7 ' +
        (n ? n + ' to resume' : h > 0 ? 'nothing unfinished' : h === 0 ? 'no history yet' : h === -2 ? 'can\u2019t reach Trakt right now' : 'checking\u2026');
    } else if (inf.state === 'not-linked') { txt = 'Trakt not linked' + (inf.err ? ' \u00b7 ' + inf.err : ''); act = 'Link \u21b5'; }
    else if (inf.state === 'unconfigured') txt = 'Trakt not linked';
    el.className = 'tstat' + (inf.state === 'linked' ? ' on' : '') + (rows[focus.r] === traktRow ? ' is-focused' : '');
    el.innerHTML = txt ? '<i></i>' + esc(txt) + (act ? '<b>' + act + '</b>' : '') : '';
    var focusable = inf.state === 'not-linked' || !!traktFlow;
    traktRow.items = focusable && txt ? [el] : []; traktRow.data = traktRow.items.length ? ['trakt'] : [];
    if (!traktRow.items.length && rows[focus.r] === traktRow) goDiscoverTop();
  }
  function renderCW(items) {
    cwItems = (items || []).filter(function (c) { return c && !c.connect; });   // Resume Watching: real unfinished Trakt content only
    var el = $('cw'), html = '';
    cwItems.forEach(function (c, i) {
      var app = APPS[c.app];
      html += '<div class="cwi" data-i="' + i + '" style="' + (app ? brandVars(app) : '') + '"><div class="cwi-bg"></div><div class="cwi-fx"></div>' +
        '<div class="cwi-bar"></div><div class="cwi-t">' + esc(c.title) + (c.mock ? '<span class="mockchip">MOCK</span>' : '') + '</div>' +
        '<div class="cwi-a">' + (app ? 'Open ' + esc(app.name) + (c.upNext ? ' to watch next' : ' to resume') + ' \u21b5' : 'Provider unknown') + '</div>' +
        '<div class="cwi-s">' + esc(c.sub || '') + '</div>' +
        '<div class="cwi-r">' + [c.remainingMin ? c.remainingMin + ' min left' : null, c.upNext && c.aired ? c.done + ' of ' + c.aired + ' watched' : null, app ? app.name : null].filter(Boolean).join(' \u00b7 ') + '</div>' +
        '<div class="cwi-p"><i style="width:' + Math.round((c.progress || 0) * 100) + '%"></i></div></div>';
    });
    $('cwTrack').innerHTML = html;
    $('cwSrc').textContent = cwItems.length && !cwItems[0].mock ? 'from Trakt' : '';
    el.className = 'cw' + (cwItems.length ? '' : ' empty');
    cwRow.items = [].slice.call($('cwTrack').children); cwRow.data = cwItems;
    if (!cwRow.items.length && rows[focus.r] === cwRow) goDiscoverTop();
    renderTraktStatus();
    resetCenters(); updateHint();
  }
  function goDiscoverTop() {
    if (picksRow.items.length) setFocus(rows.indexOf(picksRow), Math.min(1, picksRow.items.length - 1), true); else goDock();
  }
  function runtimeShort(t) {
    var m = t.runtimeMin; if (!m) return null;
    if (t.kind === 'tv') return m + ' min';
    return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm';
  }
  /* Clean card: artwork, title, year · runtime, one genre line and the rating badge. Actions only on the focused card. */
  var TOMATO = '<svg class="rt-ic" viewBox="0 0 24 24"><path fill="#fa320a" d="M12 6.2c5 0 8.6 3.1 8.6 7.4S17 21.6 12 21.6 3.4 18 3.4 13.6 7 6.2 12 6.2z"/>' +
    '<path fill="#00912d" d="M12.6 6.6c.6-1.6 1.8-2.6 3.6-2.8-.5 1-1.4 1.7-2.4 2 1.3-.2 2.6.3 3.4 1.2-1.3.4-2.7.2-3.8-.4.2 1-.3 2-1.1 2.6-.2-1-.1-1.9.3-2.6z"/></svg>';
  var SPLAT = '<svg class="rt-ic" viewBox="0 0 24 24"><path fill="#0ac855" d="M12 3l2 4.6 4.8-1.8-1.8 4.6L22 12l-4.9 1.8 1.7 4.7-4.6-1.9L12 21l-2.2-4.4-4.6 1.9 1.7-4.7L2 12l4.9-1.7L5.2 5.8 10 7.6z"/></svg>';
  function yearLine(t) {
    var x = t.kind === 'tv' && t.seasons ? t.seasons + (t.seasons === 1 ? ' season' : ' seasons') : runtimeShort(t);
    return [t.year, x].filter(Boolean).join(' \u00b7 ');
  }
  function rateHTML(t) {
    var src = t.ratingSource, rate = t.rating ? '<div class="rate' + (src === 'TMDB' ? ' tmdb' : src === 'MOCK' ? ' mock' : '') + '"><b>' +
      esc(src === 'TMDB' ? 'TMDB' : src) + '</b> <span>' + t.rating.toFixed(1) + '</span></div>' : '';
    /* Rotten Tomatoes critics score (OMDb) — only when it exists; fresh tomato >= 60 %, green splat below */
    if (t.rt != null) rate += '<div class="rate rt' + (t.rt >= 60 ? '' : ' rotten') + '">' + (t.rt >= 60 ? TOMATO : SPLAT) + '<span>' + t.rt + '%</span></div>';
    return rate ? '<div class="rates">' + rate + '</div>' : '';
  }
  function cardHTML(p, idx) {
    var t = p.item, app = APPS[t.app];
    var rate = rateHTML(t);
    /* Placeholder underneath; poster, then backdrop, as stacked backgrounds: a layer that fails to load just doesn't paint. */
    var imgs = [DSC.art(t.poster), t.backdrop].filter(Boolean).map(function (u) { return 'url(\'' + esc(u) + '\')'; }).join(',');
    var art = '<div class="card-art"><div class="ph" style="background:linear-gradient(165deg,hsl(' + (idx * 97 + 200) % 360 + ',45%,38%),hsl(' + (idx * 97 + 240) % 360 + ',50%,14%))"><b>' +
      (picksState.mode === 'mock' ? 'MOCK ART' : esc(t.title)) + '</b></div>' + (imgs ? '<div class="im" style="background-image:' + imgs + '"></div>' : '') + '</div>';
    var acts = [];
    if (app) acts.push(['open', 'Open in ' + app.name]);
    if (t.trailer) acts.push(['trailer', 'Trailer']);
    acts.push(['dismiss', 'Not interested']);
    p.acts = acts;
    var genre = (t.genres || []).filter(function (g) { return g !== 'TV Movie'; }).slice(0, 2).join(' \u00b7 ');
    return '<div class="card" data-i="' + idx + '"><div class="card-bg"></div><div class="card-fx"></div>' + art +
      '<div class="card-body">' + (picksState.mode === 'mock' ? '<span class="mockchip">MOCK</span>' : '') +
      '<div class="card-t">' + esc(t.title) + '</div>' +
      '<div class="card-y">' + esc(yearLine(t)) + '</div>' +
      (genre ? '<div class="card-g">' + esc(genre) + '</div>' : '') + rate +
      '</div>' +
      '<div class="card-acts">' + acts.map(function (a) { return '<span class="act' + (a[0] === 'dismiss' ? ' act-ni' : '') + '" data-a="' + a[0] + '">' + esc(a[1]) + '</span>'; }).join('') + '</div></div>';
  }
  function renderPicks(res, keepIdx) {
    picksState = res || { mode: 'none', picks: [] };
    var list = picksState.picks.slice(0, 3);                                   // never more than 3
    list.forEach(function (p) { sessionIds[p.item.id] = 1; });                 // Refresh never brings these back this session
    if (discoverOn) markSeen();
    var pm = !!picksState.platformMode, pname = pm ? appName(picksState.platform) : '';
    $('pkTrack').innerHTML = list.length ? list.map(cardHTML).join('') :
      '<div class="pk-none">' + (picksState.mode === 'loading' ? 'Finding the top ' + (tab === 'movie' ? 'movies' : 'shows') + ' on ' + esc(pname) + '\u2026' :
        'No ' + (tab === 'movie' ? 'movie' : 'show') + ' picks ' + (pm ? 'on ' + esc(pname) + ' ' : '') + 'right now') + '</div>';
    if (slideDir) { slideIn($('pkTrack'), slideDir); slideDir = 0; }
    if (window.RH_Wallpaper && RH_Wallpaper.addGlass) [].forEach.call($('pkTrack').querySelectorAll('.card-bg'), function (b) { RH_Wallpaper.addGlass(b); });
    var src = '';
    if (picksState.mode === 'snapshot') src = picksState.source + ' snapshot \u00b7 ratings as of ' + fmtDate(picksState.fetchedAt);
    if (pm && picksState.mode === 'live') {
      var anyRt = list.some(function (p) { return p.item.rt != null; });
      src = 'Top ' + (tab === 'movie' ? 'movies' : 'shows') + ' on ' + pname + ' (US) \u00b7 ranked by ' + (picksState.omdb ? 'IMDb' + (anyRt ? ' + Rotten Tomatoes' : '') + ' via OMDb' : 'TMDB score') +
        ' \u00b7 updated ' + fmtDate(picksState.fetchedAt);
    }
    else if (picksState.mode === 'live') src = 'TMDB trending, week of ' + fmtDate(picksState.weekOf || picksState.fetchedAt) +
      (picksState.omdb ? ' \u00b7 ratings: IMDb via OMDb' : ' \u00b7 ratings: TMDB score');
    $('pkSrc').innerHTML = picksState.mode === 'mock' ? '<span class="mockchip">MOCK DATA</span> fictional titles for layout testing (?mock=1)' : esc(src);
    if (list.length) anyPicks = true;
    $('picks').className = 'picks' + (picksState.mode !== 'none' || anyPicks ? '' : ' empty') + (platMode() ? ' has-plat' : '');
    picksRow.items = [].slice.call($('pkTrack').querySelectorAll('.card')); picksRow.data = list;
    var fr = rows[focus.r] === refreshRow ? refreshRow.data[focus.i] : null;
    if (pm && res.mode === 'live') platShown = true;
    refreshRow.items = anyPicks || pm ? [$('tabMovie'), $('tabTv')].concat(list.length && !pm ? [$('refresh')] : []) : [];
    refreshRow.data = refreshRow.items.map(function (el) { return el.getAttribute('data-k') || 'refresh'; });
    if (fr && refreshRow.data.indexOf(fr) < 0) setFocus(rows.indexOf(refreshRow), tab === 'movie' ? 0 : 1, true);
    actsRow.items = []; actsRow.parent = -1;
    resetCenters(); updateHint();
    var r = rows[focus.r];
    if (r === picksRow || r === actsRow || (focusPicksNext && r === platRow && list.length)) {
      if (picksRow.items.length) setFocus(rows.indexOf(picksRow), Math.min(keepIdx || 0, picksRow.items.length - 1), true);
      else if (pm) setFocus(rows.indexOf(platRow), 0, true);
      else goDock();
    }
    focusPicksNext = false;
    if (pm && window.RH_Wallpaper && RH_Wallpaper.placeGlass) setTimeout(function () { RH_Wallpaper.placeGlass(); }, 360);
  }
  var sessionIds = {}, anyPicks = false, focusPicksNext = false;
  function loadPlatform(opt) {
    var key = platKey(), kind = tab, got = false;
    DSC.platformPicks(key, kind, function (res) {
      if (res.platform !== platKey() || res.kind !== tab) return;   // a slow answer for another page/tab
      got = true;
      if (res.failed) {
        if (!platShown) { plats = []; paintPlat(); return loadPicks({}); }   // no live data at all: Tonight's Picks fallback (cache/snapshot)
      } else if (res.background && discoverOn && picksRow.items.length) { pendingPicks = res; return; }
      pendingPicks = null; renderPicks(res, opt.keepIdx);
      later(function () { DSC.prefetchPlatform(plats[(platI + 1) % plats.length]); DSC.prefetchPlatform(plats[(platI + plats.length - 1) % plats.length]); });
    }, opt);
    if (!got && (opt.platSwitch || !picksRow.items.length)) renderPicks({ mode: 'loading', platformMode: true, platform: key, picks: [] });
  }
  function loadPicks(opt) {
    if (!DSC || !DSC.enabled) return;
    opt = opt || {}; opt.kind = tab;
    if (opt.focusPicks) focusPicksNext = true;
    if (platMode()) return loadPlatform(opt);
    DSC.picks(function (res) {
      if (res.kind && res.kind !== tab) return;                     // a slow answer for the other tab
      if (res.exhausted) { if (!res.background) toast('No new picks left for now. These are the best ones', 2600); return; }
      // A background refresh never swaps cards under the user's focus: it waits until Discover closes.
      if (res.background && discoverOn) { pendingPicks = res; return; }
      pendingPicks = null; renderPicks(res, opt && opt.keepIdx);
    }, opt);
  }
  var pendingPicks = null;
  function loadCW() { if (DSC && DSC.enabled) DSC.continueWatching().then(renderCW, function () { renderCW([]); }); }
  function hasDiscover() { return !!(cwRow && (cwRow.items.length || picksRow.items.length)); }

  var hintTimer = null, hintArmed = false;
  function updateHint() {
    if (!hintArmed || !hasDiscover()) return;
    var n = picksRow.items.length;
    $('hint').innerHTML = esc(n ? DSC.hint(n) : 'Resume watching') + ' <b>\u2191</b>';   // e.g. "3 picks for tonight ↑", then it fades
    body.classList.add('hint-on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, (CFG.discover.hintSec || 12) * 1000);
  }
  function hideHint() { hintArmed = false; clearTimeout(hintTimer); body.classList.remove('hint-on'); }
  function armHint() { hintArmed = true; updateHint(); }

  function setDiscover(on) {
    if (on === discoverOn) return;
    discoverOn = on;
    body.classList.toggle('discover-on', on);
    if (!on && pendingPicks) { pendingPicks = null; loadPicks({}); }   // re-chosen from the refreshed cache for the current tab
    if (on) hideDock();
    if (on) { markSeen(); hideHint(); renderTraktStatus(); if (Date.now() - cwLoadedAt > 6e5) { cwLoadedAt = Date.now(); loadCW(); } }
  }
  var cwLoadedAt = 0;
  function markSeen() { if (window.RH_Discover && RH_Discover.seen) RH_Discover.seen(picksState.picks.map(function (p) { return p.item.id; })); }

  /* ---------------- dock reveal ----------------
   * Ambient shows no dock. Up/Down (or any arrow/Enter) reveals it; Back or dockAutoHideSec without a key hides it again.
   * ?dock=1 pins it (old behaviour; used by tests that are about other things). Transform + opacity only. */
  var DOCK_PIN = params.dock === '1', dockOn = false, dockTimer = null;
  function showDock() {
    if (!dockOn) { dockOn = true; body.classList.add('dock-on'); if (window.RH_Wallpaper && RH_Wallpaper.placeGlass) RH_Wallpaper.placeGlass($('dockBg')); }
    armDockHide();
  }
  function hideDock() {
    clearTimeout(dockTimer); if (DOCK_PIN && !discoverOn && !idleOn) return;
    if (inputsRow && rows[focus.r] === inputsRow) setFocus(rows.indexOf(dockRow), lastDockI, true);   // the inputs row lives inside the dock
    dockOn = false; body.classList.remove('dock-on');
  }
  function armDockHide() {
    clearTimeout(dockTimer);
    if (DOCK_PIN) return;
    dockTimer = setTimeout(function () { if (!discoverOn) hideDock(); }, (CFG.dockAutoHideSec || 8) * 1000);
  }

  /* ---------------- focus engine ---------------- */
  function resetCenters() { rows.forEach(function (r) { r.items.forEach(function (el) { el.__cx = undefined; }); }); }
  function centerX(el) {   // layout-space centre (ignores transforms), cached until the row re-renders
    if (el.__cx !== undefined) return el.__cx;
    var x = 0, n = el;
    while (n && n.id !== 'stage') { x += n.offsetLeft || 0; n = n.offsetParent; }
    return (el.__cx = x + el.offsetWidth / 2);
  }
  function cur() { var r = rows[focus.r]; return r && r.items[focus.i]; }
  var saveTimer = null;
  function setFocus(r, i, silent) {
    var prev = cur(); if (prev) prev.classList.remove('is-focused');
    var prevRow = rows[focus.r];
    focus.r = r; focus.i = i;
    var row = rows[r], el = cur(); if (!el) return;
    el.classList.add('is-focused');
    // the card whose actions are open stays "lifted"
    if (prevRow === actsRow && row !== actsRow && picksRow.items[actsRow.parent]) picksRow.items[actsRow.parent].classList.remove('act-open');
    if (row === picksRow) { actsRow.parent = i; actsRow.items = [].slice.call(el.querySelectorAll('.act')); actsRow.data = (picksRow.data[i].acts || []).map(function (a) { return a[0]; }); }
    if (row === actsRow) { var pc = picksRow.items[actsRow.parent]; if (pc) pc.classList.add('act-open'); }
    var k = row.kind;
    if (k === 'trakt' || k === 'cw' || k === 'plat' || k === 'tabs' || k === 'picks' || k === 'acts') setDiscover(true);
    if (k === 'tabs' && row.data[i] !== 'refresh') switchTab(row.data[i]);            // Left/Right on the tab row switches tabs
    if ((row === dockRow || row === inputsRow) && prevRow && prevRow !== dockRow && prevRow !== inputsRow && !silent) showDock();
    if (k === 'apps' || k === 'inputs') setDiscover(false);
    body.classList.toggle('info-focus', k === 'info');
    if (!silent && row === dockRow) { clearTimeout(saveTimer); saveTimer = setTimeout(function () { store('rh.focus', String(i)); }, 1000); }
  }
  function avail(rw, from) {
    if (!rw.items.length) return false;
    if (rw.kind === 'info') return body.classList.contains('has-wp');
    if (rw.kind === 'acts') return from === picksRow || from === actsRow;
    if (rw.kind === 'inputs') return from === dockRow && dockOn && !discoverOn;
    if (rw.kind === 'tabs' || rw.kind === 'plat') return from === picksRow || from === refreshRow || from === platRow || from === cwRow || from === traktRow;
    return true;
  }
  function goDock() { var f = parseInt(store('rh.focus'), 10); setFocus(rows.indexOf(dockRow), dockRow.items[f] ? f : (lastDockI || 0)); }
  var lastDockI = 0;
  function move(dr, di) {
    var row = rows[focus.r];
    if (di && row === platRow) return switchPlatform(di);                     // ‹ › on the platform header
    if (di) {
      var ni = focus.i + di;
      if (row === picksRow && (ni < 0 || ni >= row.items.length) && platMode()) return switchPlatform(di, di < 0 ? 'last' : 'first');   // past the edge: next service
      if (ni >= 0 && ni < row.items.length) setFocus(focus.r, ni);
      else nudge(di, 0);
      return;
    }
    if (row === dockRow) lastDockI = focus.i;
    // explicit hops: Up from the dock opens Discover (Resume first); Down from info/Discover lands on the dock
    if (row === dockRow && dr < 0 && hasDiscover()) {
      if (cwRow.items.length) return setFocus(rows.indexOf(cwRow), 0);     // real unfinished Trakt content always comes first
      if (!picksRow.items.length && platRow.items.length) return setFocus(rows.indexOf(platRow), 0);
      if (!picksRow.items.length && refreshRow.items.length) return setFocus(rows.indexOf(refreshRow), tab === 'movie' ? 0 : 1);
      if (!picksRow.items.length) return setFocus(rows.indexOf(traktRow), 0);
      return setFocus(rows.indexOf(picksRow), Math.min(1, picksRow.items.length - 1));
    }
    if (row === infoRow && dr > 0 && !discoverOn) return setFocus(rows.indexOf(dockRow), lastDockI);
    if (row === actsRow && dr < 0) return setFocus(rows.indexOf(picksRow), actsRow.parent);
    if (row === picksRow && dr < 0 && refreshRow.items.length) return setFocus(rows.indexOf(refreshRow), tab === 'movie' ? 0 : 1);   // Up lands on the current tab
    if (row === picksRow && dr > 0 && actsRow.items.length) return setFocus(rows.indexOf(actsRow), 0);
    if ((row === actsRow || row === picksRow) && dr > 0) return setFocus(rows.indexOf(dockRow), lastDockI);
    var nr = -1, ny = dr > 0 ? 1e9 : -1e9, y0 = row.y;
    rows.forEach(function (rw, idx) {   // nearest available row above/below in screen order
      if (!avail(rw, row)) return;
      if (dr > 0 ? (rw.y > y0 && rw.y < ny) : (rw.y < y0 && rw.y > ny)) { ny = rw.y; nr = idx; }
    });
    if (nr < 0) { nudge(0, dr); return; }
    if (rows[nr] === dockRow) return setFocus(nr, lastDockI);
    var x = centerX(cur()), best = 0, bd = 1e9;
    rows[nr].items.forEach(function (el, idx) { var d = Math.abs(centerX(el) - x); if (d < bd) { bd = d; best = idx; } });
    setFocus(nr, best);
  }
  var lastNudge = null;
  function nudge(dx, dy) { // tiny edge bump; a new press cancels the previous one (never queues)
    var el = cur(); if (!el || !el.animate) return;
    if (lastNudge) { try { lastNudge.cancel(); } catch (e) {} }
    var tf = getComputedStyle(el).transform; if (!tf || tf === 'none') tf = 'translateZ(0)';
    lastNudge = el.animate([{ transform: tf },
      { transform: 'translate3d(' + (dx || 0) * 8 + 'px,' + (dy || 0) * 8 + 'px,0) ' + tf },
      { transform: tf }], { duration: 160, easing: 'ease-out' });
  }
  function press(el) {
    el.classList.add('is-pressed');
    setTimeout(function () { el.classList.remove('is-pressed'); }, 120);
  }

  /* ---------------- launching ---------------- */
  var installed = {};   // appKey -> tizen app id (from getAppsInfo)
  // Helper/background entries share the app's name on some firmware and launch nothing useful.
  var HELPER_RE = /worker|service|dummy/i, HELPER_CS = /BG/;
  function isHelper(name) { return HELPER_RE.test(name) || HELPER_CS.test(name); }
  function norm(n) { return String(n).replace(/\s+/g, ' ').replace(/^\s|\s$/g, '').toLowerCase(); }
  function resolveByName(app, list) {
    var ids = {}, i, k, exact = null, loose = null;
    for (i = 0; i < list.length; i++) if (list[i] && list[i].id) ids[list[i].id] = list[i];
    for (k = 0; k < (app.tizenIds || []).length; k++) if (ids[app.tizenIds[k]]) return app.tizenIds[k]; // a known ID is installed
    var names = (app.names || [app.name]).map(norm);
    for (i = 0; i < list.length; i++) {
      var e = list[i]; if (!e || !e.id || !e.name || isHelper(e.name) || isHelper(e.id)) continue;
      if (!exact && names.indexOf(norm(e.name)) >= 0) exact = e.id;
      if (!loose && app.match && app.match.test(e.name)) loose = e.id;
    }
    return exact || loose;
  }
  function matchInstalled(list) {
    Object.keys(APPS).forEach(function (key) {
      var id = resolveByName(APPS[key], list || []);
      if (id) installed[key] = id; else delete installed[key];
    });
    log('installed map', installed);
  }
  function getAppsInfo() {
    return new Promise(function (res, rej) {
      try { tizen.application.getAppsInfo(res, rej); } catch (e) { rej(e); }
    });
  }
  function tryLaunch(id) {
    return new Promise(function (res, rej) {
      try { tizen.application.launch(id, function () { res(id); }, function (e) { rej(e); }); }
      catch (e) { rej(e); }
    });
  }
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { if (x && !s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function unstore(k) { try { localStorage.removeItem(k); } catch (e) {} }
  var launching = false;
  function launchApp(key) {
    var app = APPS[key]; if (!app || launching) return;
    launching = true;
    if (DSC && DSC.noteLaunch) DSC.noteLaunch(key);   // local usage count: orders the Discover platform pages
    var cacheKey = 'rh.appid.' + key, cached = store(cacheKey);
    var ids = params.noresolve ? [] : uniq([].concat(CFG.appIdOverrides[key] || [], app.tizenIds || [], [cached, installed[key]]));
    var tried = {}, i = 0;
    function next() {
      if (i >= ids.length) return byName();
      var id = ids[i++]; tried[id] = 1;
      return tryLaunch(id).then(done, function (e) {
        log('launch failed', id, e && e.name);
        if (id === store(cacheKey)) unstore(cacheKey);     // never keep an ID that failed
        return next();
      });
    }
    function byName() {   // fresh installed list, then store IDs as the very last resort
      return getAppsInfo().then(function (list) { matchInstalled(list); }, function () {}).then(function () {
        var rest = uniq([installed[key]].concat(app.storeIds || [])).filter(function (x) { return !tried[x]; });
        if (!rest.length) throw new Error('not found');
        ids = ids.concat(rest); return next();
      });
    }
    function done(id) { store(cacheKey, id); log('launched', key, id); }
    next().catch(function () {
      toast('Couldn\u2019t open ' + app.name + '. Is it installed?', 3000);
    }).then(function () { setTimeout(function () { launching = false; }, 250); });
  }
  /* YouTube trailer: the only title-level deep link with a known (community-documented) Tizen route —
   * an appcontrol "view" with the watch URL. Falls back to just opening YouTube. */
  function playTrailer(key) {
    var app = APPS.youtube, id = store('rh.appid.youtube') || installed.youtube || (app.tizenIds || [])[0];
    function fallback() { launchApp('youtube'); toast('Opened YouTube. Couldn\u2019t open the trailer directly', 3000); }
    try {
      var ac = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', 'https://www.youtube.com/watch?v=' + key, null, null, null);
      tizen.application.launchAppControl(ac, id, function () {}, fallback);
    } catch (e) { fallback(); }
  }
  function activate() {
    var row = rows[focus.r], el = cur(); if (!el) return;
    press(el);
    if (row.kind === 'apps') return launchApp(row.data[focus.i]);
    if (row.kind === 'info') return toggleCredit();
    if (row.kind === 'inputs') return activateInput(row.data[focus.i]);
    if (row.kind === 'plat') return launchApp(platKey());
    if (row.kind === 'tabs') { if (row.data[focus.i] === 'refresh') { hideHint(); return refreshPicks(); } return; }
    if (row.kind === 'trakt') return traktFlow ? toast('Waiting for trakt.tv/activate\u2026', 2000) : startTraktConnect();
    if (row.kind === 'cw') {
      var c = row.data[focus.i];
      if (c && APPS[c.app]) return launchApp(c.app);
      return toast('Which app has this isn\u2019t known. Add a TMDB key to find out', 3000);
    }
    if (row.kind === 'picks') {   // Enter on a card = its app; never dismisses by accident
      var pk = picksRow.data[focus.i];
      return doAct(pk, (pk.acts[0] || [])[0] === 'open' ? 'open' : null, focus.i);
    }
    if (row.kind === 'acts') return doAct(picksRow.data[actsRow.parent], actsRow.data[focus.i], actsRow.parent);
  }
  function startTraktConnect() {
    DSC.trakt.start(function (info) { traktFlow = info; renderTraktStatus(); }, function (ok, why) {
      traktFlow = null;
      if (ok) { toast('Trakt linked', 2400); cwLoadedAt = Date.now(); loadCW(); loadPicks({ force: true }); }
      else toast('Trakt: ' + (why || 'not linked'), 3600);
      renderTraktStatus();
    });
  }
  function idsOnScreen() { var o = {}; picksRow.data.forEach(function (p) { o[p.item.id] = 1; }); return o; }
  /* Refresh: 3 different qualified picks, never a title already shown this session (same genre/runtime rules). */
  function refreshPicks() { loadPicks({ skip: sessionIds, strict: true, keepIdx: 0 }); }
  function doAct(p, a, idx) {
    if (!p) return;
    var t = p.item;
    if (a === 'open') { DSC.selected(t); return launchApp(t.app); }
    if (a === 'trailer') { DSC.selected(t); return playTrailer(t.trailer); }
    if (a === 'dismiss') {                                                       // 'Not interested' (also the Yellow key on a card)
      DSC.dismiss(t.id, t);
      toast('Not interested: \u201c' + t.title + '\u201d. It won\u2019t be suggested again', 2600);
      var keep = idsOnScreen(), skip = {};
      Object.keys(sessionIds).forEach(function (k) { if (!keep[k]) skip[k] = 1; });   // the other two cards stay put
      return loadPicks({ keepIdx: idx, skip: skip });
    }
    // no provider known (offline snapshot): never pretend there is a Watch button
    toast('Where to watch isn\u2019t known offline. Add a TMDB key (see README)', 3200);
  }

  /* ---------------- idle / always-on ----------------
   * After idle.minutes without a key: dock, clock, greeting, hints and Discover fade out (opacity), the wallpaper stays and
   * rotates slower, and a black overlay dims it in steps. Any key wakes instantly; that first key is swallowed. */
  var IDLE = CFG.idle || {}, idleOn = false, idleTimers = [];
  var idleUnit = params.idlescale ? Number(params.idlescale) * 1000 : 6e4;     // ms per "minute" (?idlescale=0.2 for previews/tests)
  function idleClear() { idleTimers.forEach(clearTimeout); idleTimers = []; }
  function armIdle() {
    idleClear();
    if (IDLE.enabled === false || params.idle === '0') return;
    idleTimers.push(setTimeout(enterIdle, (IDLE.minutes || 10) * idleUnit));
    armSaver();
  }
  /* ---------------- picks screensaver (js/saver.js) ----------------
   * After screensaver.minutes without a key, on the plain ambient home only (never over Discover, the dock, the voice
   * overlay, a toast or the photo credit): full-screen backdrops of the current real picks. OK opens the title the same
   * way a pick card does; any other key just closes it (its action is not performed). Snapshot/mock picks: no saver. */
  var SAVER = CFG.screensaver || {}, saverTimer = null;
  function armSaver(ms) {
    clearTimeout(saverTimer);
    if (SAVER.enabled === false || params.saver === '0' || !window.RH_Saver || (window.RH_Saver.on)) return;
    saverTimer = setTimeout(function () { trySaver(false); }, ms || (SAVER.minutes || 5) * idleUnit);
  }
  function saverItems() {
    if (picksState.mode === 'mock' || picksState.mode === 'none') return [];
    return picksState.picks.filter(function (p) { return p.item && p.item.backdrop && RH_Saver.hires(p.item.backdrop); }).map(function (p) {
      var t = p.item, open = p.acts && p.acts[0] && p.acts[0][0] === 'open';
      return { title: t.title, backdrop: t.backdrop, badges: rateHTML(t), appName: open && APPS[t.app] ? APPS[t.app].name : '', data: p };
    });
  }
  function saverBlocked() {
    return document.hidden || discoverOn || dockOn || launching || (window.RH_Voice && RH_Voice.open) || body.classList.contains('voice-on') ||
      $('toast').className.indexOf('show') >= 0 || (body.classList.contains('show-credit') && !(CFG.wallpaper || {}).showCredit) || rows[focus.r] !== dockRow;
  }
  function trySaver(force) {
    if (!window.RH_Saver || RH_Saver.on || RH_Saver.pending) return;
    var list = saverItems();
    if (!list.length || (!force && saverBlocked())) return armSaver(idleUnit);     // check again in a minute
    hideHint();
    RH_Saver.start(list).then(function (shown) {
      if (!shown) return armSaver(idleUnit);
      if (saverBlocked() && !force) return exitSaver();                            // something opened while the art loaded
      if (window.RH_Wallpaper && RH_Wallpaper.pause) RH_Wallpaper.pause(true);
    });
  }
  function exitSaver() {
    if (!window.RH_Saver || (!RH_Saver.on && !RH_Saver.pending)) return;
    RH_Saver.stop();
    if (window.RH_Wallpaper && RH_Wallpaper.pause) RH_Wallpaper.pause(false);
  }
  function setDim(brightness, ms) {
    var d = $('dim'); if (!d) return;
    d.style.setProperty('--dim-ms', (ms || 0) + 'ms');
    d.style.opacity = String(Math.max(0, Math.min(0.9, 1 - brightness)));
  }
  function enterIdle() {
    if (idleOn) return;
    idleOn = true; idleClear();
    hideHint(); toggleCredit(false); hideDock();
    var fade = IDLE.fadeMs || 1500;
    document.documentElement.style.setProperty('--idle-fade', fade + 'ms');
    body.classList.add('idle');
    (IDLE.dim || []).forEach(function (st) {
      var at = Math.max(0, (st.afterMin - (IDLE.minutes || 10)) * idleUnit);
      idleTimers.push(setTimeout(function () { setDim(st.brightness, IDLE.dimMs || 8000); }, at));
    });
    if (window.RH_Wallpaper && RH_Wallpaper.setInterval && IDLE.intervalSec) { wpIntervalAwake = RH_Wallpaper.intervalSec; RH_Wallpaper.setInterval(IDLE.intervalSec); }
    idleTimers.push(setTimeout(function () { if (discoverOn) setFocus(rows.indexOf(dockRow), lastDockI, true); hideDock(); }, fade + 50));   // wake into Ambient
  }
  var wpIntervalAwake = null;
  function wake() {
    idleOn = false; idleClear();
    body.classList.add('wake-now');                                   // no fade-in: everything is back on this frame
    body.classList.remove('idle'); setDim(1, 0);
    void body.offsetWidth;
    requestAnimationFrame(function () { body.classList.remove('wake-now'); });
    if (window.RH_Wallpaper && RH_Wallpaper.setInterval && wpIntervalAwake !== null) { RH_Wallpaper.setInterval(wpIntervalAwake); wpIntervalAwake = null; }
    tick(); armIdle();
    if (DSC && DSC.enabled && !discoverOn) armHint();
  }
  /* Keep the TV's own screensaver away while the launcher is up (official Samsung AppCommon API, Tizen only);
   * the idle mode above dims and rotates instead. Handed back to the system when another app is in front. */
  function screenSaver(on) {
    if (!IS_TIZEN || IDLE.keepScreenOn === false) return;
    try {
      var ac = window.webapis && webapis.appcommon;
      if (ac && ac.setScreenSaver && ac.AppCommonScreenSaverState) {
        ac.setScreenSaver(on ? ac.AppCommonScreenSaverState.SCREEN_SAVER_ON : ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF, function () {}, function () {});
      }
    } catch (e) { log('setScreenSaver', e); }
  }
  function loadWebapis() {
    if (!IS_TIZEN || IDLE.keepScreenOn === false) return;
    if (window.webapis && webapis.appcommon) return screenSaver(false);
    try {
      var sc = document.createElement('script');
      sc.src = '$WEBAPIS/webapis/webapis.js';                         // Samsung Product API, resolved by the TV's web runtime
      sc.onload = function () { screenSaver(false); };
      sc.onerror = function () { log('webapis.js unavailable'); };
      document.head.appendChild(sc);
    } catch (e) {}
  }

  /* ---------------- back handling ---------------- */
  var backArmed = 0;
  function onBack() {
    var home = rows.indexOf(dockRow);
    if (body.classList.contains('show-credit') && !(CFG.wallpaper || {}).showCredit) { toggleCredit(false); return; }
    if (rows[focus.r] === actsRow) { setFocus(rows.indexOf(picksRow), actsRow.parent); return; }
    if (discoverOn || rows[focus.r] === infoRow) { setFocus(home, lastDockI); hideDock(); backArmed = 0; return; }
    if (dockOn && !DOCK_PIN) { hideDock(); backArmed = 0; return; }                   // Back in the revealed dock hides it
    if (focus.r !== home || focus.i !== 0) { setFocus(home, 0); backArmed = 0; return; }
    if (CFG.back.mode !== 'double') return;
    var now = Date.now();
    if (now - backArmed < CFG.back.windowMs) {
      try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
      backArmed = 0;
    } else { backArmed = now; toast('Press Back again to exit', CFG.back.windowMs); }
  }

  /* ---------------- glass / performance ---------------- */
  var MODES = ['baked', 'live', 'off'], LEGACY = { full: 'live', lite: 'baked', auto: 'baked' };
  function setBlur(mode, persist) {
    mode = LEGACY[mode] || mode; if (MODES.indexOf(mode) < 0) mode = 'baked';
    body.classList.remove('blur-baked', 'blur-live', 'blur-off');
    body.classList.add('blur-' + mode);
    body.setAttribute('data-blur', mode);
    if (persist) store('rh.blur', mode);
  }
  function startWallpaper() {
    var W = CFG.wallpaper || {};
    if (W.enabled === false || params.wp === 'off' || !window.RH_Wallpaper) return;
    var motion = (W.motion === true && !params.still) || params.motion === '1';
    RH_Wallpaper.start(window.RH_WALLPAPERS || [], {
      intervalSec: params.wpint ? Number(params.wpint) : (W.intervalSec === undefined ? 50 : W.intervalSec),
      fadeMs: params.fade ? Number(params.fade) : (W.fadeMs || 600),
      motion: motion,
      shuffle: !!W.shuffle,
      showCaption: W.showCaption !== false,
      showCredit: W.showCredit !== false,
      start: params.wp,
      pref: window.RH_DayNight ? RH_DayNight.pref() : null,                  // day / night photo set (js/daynight.js)
      tod: W.timeOfDay
    });
    if (!motion) body.classList.add('wp-still');
    RH_Wallpaper.addGlass($('dockBg'));
    RH_Wallpaper.addGlass(clockEl);
  }
  function cycleBlur() {
    var m = body.getAttribute('data-blur'), n = MODES[(MODES.indexOf(m) + 1) % MODES.length];
    setBlur(n, true); toast('Glass: ' + (n === 'baked' ? 'baked (pre-blurred, fastest)' : n === 'live' ? 'live blur (heavier)' : 'solid (no blur)'));
  }
  function measureFps(ms) {
    return new Promise(function (res) {
      var n = 0, t0 = 0;
      function f(t) { if (!t0) t0 = t; n++; if (t - t0 < ms) requestAnimationFrame(f); else res(n * 1000 / (t - t0)); }
      requestAnimationFrame(f);
    });
  }
  var fpsOn = false;   // Green key: on-demand FPS readout (nothing runs per frame unless it is visible)
  function toggleFps() {
    fpsOn = !fpsOn; $('fps').className = 'fps' + (fpsOn ? ' show' : '');
    if (!fpsOn) return;
    (function loop() { if (!fpsOn) return; measureFps(1000).then(function (f) { $('fps').textContent = Math.round(f) + ' fps \u00b7 ' + body.getAttribute('data-blur'); loop(); }); })();
  }

  /* ---------------- keys ---------------- */
  function registerKeys() {
    if (!IS_TIZEN || !tizen.tvinputdevice) return;
    ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown', 'MediaFastForward', 'MediaRewind', 'MediaPlayPause', 'MediaPlay', 'Info'].forEach(function (k) {
      try { tizen.tvinputdevice.registerKey(k); } catch (e) { log('registerKey', k, e); }
    });
  }
  function onKey(e) {
    var k = e.keyCode;
    if (window.RH_Saver && RH_Saver.on) {                                 // screensaver: OK opens the title, any other key only closes it
      e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      var sv = RH_Saver.current;
      exitSaver();
      if (idleOn) wake(); else armIdle();
      if (k === KEY.ENTER && !e.repeat && sv) doAct(sv.data, sv.appName ? 'open' : null);
      return;
    }
    if (window.RH_Saver && RH_Saver.pending) exitSaver();               // art still loading: cancel, the key acts normally
    if (idleOn) { e.preventDefault(); wake(); return; }                 // the first key only wakes
    armIdle();
    if (window.RH_Voice && window.RH_Voice.onKey(e)) return;            // voice overlay (js/voice.js) owns the remote while open
    if (hintArmed && k !== KEY.UP) hideHint();
    var arrow = k === KEY.LEFT || k === KEY.RIGHT || k === KEY.UP || k === KEY.DOWN || k === KEY.ENTER;
    if (arrow && !dockOn && !discoverOn && rows[focus.r] === dockRow) { e.preventDefault(); showDock(); return; }   // first press only reveals the dock
    if (dockOn && !discoverOn) armDockHide();
    switch (k) {   // handled synchronously: no debounce, no queue; CSS transitions retarget on rapid presses
      case KEY.LEFT: e.preventDefault(); move(0, -1); return;
      case KEY.RIGHT: e.preventDefault(); move(0, 1); return;
      case KEY.UP: e.preventDefault(); move(-1, 0); return;
      case KEY.DOWN: e.preventDefault(); move(1, 0); return;
      case KEY.ENTER: e.preventDefault(); if (!e.repeat) activate(); return;
      case KEY.BACK: case KEY.ESC: case KEY.BACKSPACE: e.preventDefault(); onBack(); return;
      case KEY.RED: case 82 /* r (preview) */: cycleBlur(); return;
      case KEY.GREEN: case 70 /* f (preview) */: toggleFps(); return;
      case KEY.BLUE: case 78 /* n (preview) */: if (window.RH_Wallpaper) RH_Wallpaper.next(); return;
      case KEY.YELLOW: case 73 /* i (preview) */:                        // on a pick: Not interested; elsewhere: photo credit
        if (rows[focus.r] === picksRow) return doAct(picksRow.data[focus.i], 'dismiss', focus.i);
        if (rows[focus.r] === actsRow) return doAct(picksRow.data[actsRow.parent], 'dismiss', actsRow.parent);
        toggleCredit(); return;
      case 80 /* p (preview): new picks */: if (!platMode()) refreshPicks(); return;
      case 427: case 417: case 34: /* ChannelUp / FastForward / PageDown (preview): next service */
      case 428: case 412: case 33: /* ChannelDown / Rewind / PageUp: previous service */
        if (discoverOn && platMode()) { e.preventDefault(); switchPlatform(k === 427 || k === 417 || k === 34 ? 1 : -1, 'first'); }
        return;
    }
  }

  /* ---------------- cache versioning ---------------- */
  // v2 (Oct 2026): verified app IDs; drops cached app IDs, old focus and the old blur-probe result.
  var CACHE_VERSION = '2';
  function migrateCache() {
    if (store('rh.cachever') === CACHE_VERSION) return;
    try {
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf('rh.appid.') === 0 || k === 'rh.focus' || k === 'rh.blur.auto')) drop.push(k);
      }
      drop.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
    store('rh.cachever', CACHE_VERSION);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    // 1) first paint: only what is visible in Ambient
    clockEl = document.querySelector('.clock');
    if (params.reduce === '1' || CFG.ui.reducedMotion) body.classList.add('reduce-motion');
    var hasWp = (CFG.wallpaper || {}).enabled !== false && params.wp !== 'off';
    if (CFG.ui.ambientMotion && !hasWp && !params.still) body.classList.add('motion');
    migrateCache();
    setBlur(params.blur || store('rh.blur') || CFG.ui.blur);
    if ((CFG.wallpaper || {}).showCredit) body.classList.add('show-credit');
    buildDock();
    buildInfo();
    buildDiscover();
    fitStage(); window.addEventListener('resize', fitStage);
    tick();
    var f = parseInt(store('rh.focus'), 10);
    lastDockI = dockRow.items[f] ? f : 0;
    setFocus(rows.indexOf(dockRow), lastDockI, true);
    if (DOCK_PIN) { dockOn = true; body.classList.add('dock-on'); }
    document.addEventListener('keydown', onKey);
    if (window.RH_DayNight) RH_DayNight.start();                     // body.day / body.night before the first photo
    startWallpaper();
    armIdle();
    registerKeys();
    // 2) after first paint, when idle: app resolution, Discover data
    requestAnimationFrame(function () { setTimeout(function () {
      later(function () {
        if (!params.noresolve) getAppsInfo().then(matchInstalled, function (e) { log('getAppsInfo failed', e); });
        loadWebapis();
        if (window.RH_Weather && params.wx !== '0') RH_Weather.start($('wx'));
        startInputs();
        if (DSC && DSC.enabled && params.discover !== '0') {
          armHint();
          loadPicks({});
          cwLoadedAt = Date.now(); loadCW();
        }
      });
    }, 0); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { idleClear(); clearTimeout(saverTimer); exitSaver(); screenSaver(true); return; }
      tick(); launching = false; screenSaver(false);
      if (idleOn) return wake();                               // back from an app: straight to the normal home
      armIdle();
      if (DSC && DSC.enabled && !discoverOn) armHint();        // "wake": one hint line ("3 picks for tonight ↑"); Discover never opens by itself
    });
    // Small API for js/voice.js: open an app, or show one service's picks in Discover
    window.RH_Home = { launchApp: launchApp, wake: function () { exitSaver(); if (idleOn) wake(); },
      showPlatform: function (key) {
        var i = plats.indexOf(key);
        if (i < 0) return launchApp(key);                      // not a Discover page (e.g. YouTube): just open it
        var d = i - platI; platI = i; pendingPicks = null; paintPlat();
        loadPicks({ keepIdx: 0, platSwitch: true, focusPicks: true });
        if (!discoverOn && platRow && platRow.items.length) setFocus(rows.indexOf(platRow), 0);
        return d;
      } };
    // Debug hooks for automated preview/testing
    window.RH_debug = { focus: focus, rows: rows, setFocus: setFocus, launchApp: launchApp, installed: installed, toggleCredit: toggleCredit,
      get discoverOn() { return discoverOn; }, rowIndex: function (k) { for (var i = 0; i < rows.length; i++) if (rows[i].kind === k) return i; return -1; },
      picks: function () { return picksState; }, get platform() { return platMode() ? platKey() : null; }, platforms: function () { return plats.slice(); },
      switchPlatform: switchPlatform, reloadPicks: loadPicks, refresh: refreshPicks, session: function () { return sessionIds; },
      get idle() { return idleOn; }, get dockOn() { return dockOn; }, get tab() { return tab; }, switchTab: switchTab, enterIdle: enterIdle, wake: wake, traktStatus: function () { return $('tstat').textContent; },
      saver: function (force) { trySaver(force !== false); }, saverItems: function () { return saverItems().length; }, exitSaver: exitSaver,
      get saverOn() { return !!(window.RH_Saver && RH_Saver.on); }, inputs: function () { return inputsRow ? inputsRow.data : []; } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
