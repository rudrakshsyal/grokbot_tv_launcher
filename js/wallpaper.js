/*
 * RH_Wallpaper — scenic wallpaper rotator.
 * Two stacked <img> layers crossfade (opacity, 600 ms). Still by default; optional slow Ken Burns drift (transform only).
 * "Baked glass": every glass surface registered with addGlass() shows a pre-blurred 480x270 copy of the current
 * wallpaper (w.blur), clipped to the surface's position — crossfaded in sync with the photo, zero per-frame blur cost.
 * The next image is preloaded when the TV is idle, after first paint; its URL is remembered so the next launch can
 * start fetching it from an inline <script> before any JS has loaded.
 * Chromium-76 safe (no ?. / ??). If every image fails, the gradient ambient stays.
 */
(function () {
  'use strict';
  var KB = ['kb1', 'kb2', 'kb3', 'kb4'];
  var state = { list: [], idx: -1, front: null, back: null, timer: null, motion: true, opt: null, ready: false, fails: 0 };

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function decode(img, src) {
    return new Promise(function (res, rej) {
      img.onload = function () {
        if (img.decode) img.decode().then(res, res); else res();   // decode off the main thread when possible
      };
      img.onerror = rej;
      if (img.getAttribute('src') === src) {           // already preloaded (or started early by index.html)
        if (img.complete) { if (img.naturalWidth) img.onload(); else rej(new Error('load')); }
        return;
      }
      img.src = src;
    });
  }
  function startKb(img, n) {
    img.style.animation = 'none';
    void img.offsetWidth;   // restart the animation
    if (!state.motion) { img.style.animation = ''; img.className = 'wp'; return; }
    var dur = (state.opt.intervalSec * 1000 + state.opt.fadeMs * 2) / 1000;
    img.style.animation = KB[n % KB.length] + ' ' + dur + 's linear forwards';
  }
  function caption(w) {
    var el = document.getElementById('wpcap'); if (!el) return;
    if (!state.opt.showCaption) { el.className = 'wpcap'; return; }
    el.className = 'wpcap';                    // fade out, swap text, fade in
    setTimeout(function () {
      el.querySelector('.wpcap-place').textContent = w.caption || '';
      el.querySelector('.wpcap-credit').textContent = w.credit || '';   // visibility: body.show-credit
      el.className = 'wpcap show';
    }, 600);
  }
  /* ---------- baked glass ---------- */
  var glass = [];               // { el, a, b, front }
  function stageOffset(el) {
    var st = document.getElementById('stage'), r = el.getBoundingClientRect(), s = st.getBoundingClientRect(), k = s.width / 1920 || 1;
    return { x: Math.round((r.left - s.left) / k), y: Math.round((r.top - s.top) / k) };
  }
  function placeGlass(g) {
    var o = stageOffset(g.el), pos = (-o.x) + 'px ' + (-o.y) + 'px';
    g.a.style.backgroundPosition = pos; g.b.style.backgroundPosition = pos;
  }
  function addGlass(el) {
    if (!el || el.__bk) return;
    var bk = document.createElement('div'); bk.className = 'bk'; bk.innerHTML = '<i></i><i></i>';
    el.insertBefore(bk, el.firstChild);
    var g = { el: el, a: bk.children[0], b: bk.children[1], front: null };
    el.__bk = g; glass.push(g); placeGlass(g);
    var w = state.list[state.idx];
    if (w && w.blur) { g.a.style.backgroundImage = 'url("' + w.blur + '")'; g.a.className = 'on'; g.front = g.a; }
  }
  function glassTo(url) {
    glass = glass.filter(function (g) { return document.body.contains(g.el); });   // drop surfaces of re-rendered cards
    glass.forEach(function (g) {
      var nxt = g.front === g.a ? g.b : g.a, prev = g.front;
      nxt.style.backgroundImage = 'url("' + url + '")';
      if (prev) prev.className = 'on';
      nxt.className = 'on top';
      g.front = nxt;
      setTimeout(function () { if (g.front === nxt && prev) { prev.className = ''; nxt.className = 'on'; } }, state.opt.fadeMs + 120);
    });
  }
  function idle(fn, ms) {
    if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: ms || 4000 }); else setTimeout(fn, 300);
  }
  function loadBlur(w) {     // tiny (≈6 KB); resolve even on failure so the photo still changes
    return new Promise(function (res) {
      if (!w.blur) return res(false);
      var im = new Image(); im.onload = function () { res(true); }; im.onerror = function () { res(false); }; im.src = w.blur;
    });
  }

  var busy = false;
  function show(i) {
    if (busy) return Promise.resolve();
    busy = true;
    var w = state.list[i], img = state.back, blurOk = false;
    return Promise.all([decode(img, w.src), loadBlur(w).then(function (ok) { blurOk = ok; })]).then(function () {
      busy = false; state.fails = 0;
      startKb(img, i);
      // Crossfade without a dip: the old image stays fully opaque underneath while the new one
      // fades in on top; the old one is hidden only after the fade has finished.
      var prev = state.front;
      if (prev.className.indexOf('on') >= 0) prev.className = 'wp under';
      void img.offsetWidth;                         // commit opacity:0 before fading in
      img.className = 'wp on';
      if (blurOk) glassTo(w.blur);
      state.front = img; state.back = prev;
      state.idx = i; store('rh.wp.idx', String(i));
      var nw = state.list[(i + 1) % state.list.length];
      store('rh.wp.early', nw.src + '|' + (nw.blur || ''));   // index.html starts this download on the next launch
      caption(w);
      if (!state.ready) { state.ready = true; document.body.classList.add('has-wp'); document.body.classList.add('wp-ready'); }
      // After the fade, park the old layer on the *next* image so it is decoded and ready.
      var old = state.back;
      setTimeout(function () {
        if (old === state.front) return;           // a newer switch already reused this layer
        old.className = 'wp';                      // hidden instantly (covered by the new image)
        old.style.animation = 'none';
        // Preload the next photo only when the TV is idle (never during first paint or key handling).
        idle(function () { if (old !== state.front) preloadInto(old, (i + 1) % state.list.length); }, 8000);
      }, state.opt.fadeMs + 200);
    }, function () {
      busy = false; state.fails++;
      if (state.fails >= state.list.length) return;   // give up; gradient background remains
      return show((i + 1) % state.list.length);
    });
  }
  function preloadInto(img, i) {
    decode(img, state.list[i].src).then(function () {}, function () {});
    loadBlur(state.list[i]);
  }
  function schedule() {
    clearTimeout(state.timer);
    if (state.opt.intervalSec <= 0 || state.list.length < 2) return;
    state.timer = setTimeout(function () {
      if (document.hidden) { schedule(); return; }
      show((state.idx + 1) % state.list.length).then(schedule, schedule);
    }, state.opt.intervalSec * 1000);
  }

  window.RH_Wallpaper = {
    /* opt: { intervalSec, fadeMs, motion, shuffle, showCaption, showCredit, start (index|id) } */
    start: function (list, opt) {
      state.list = (list || []).filter(function (w) { return w && w.src; });
      state.opt = opt; state.motion = !!opt.motion;
      state.front = document.getElementById('wpA'); state.back = document.getElementById('wpB');
      if (!state.list.length || !state.front) return;
      document.documentElement.style.setProperty('--wp-fade', opt.fadeMs + 'ms');
      var start = 0, s = opt.start;
      document.body.classList.toggle('wp-motion', state.motion);
      if (s !== undefined && s !== null && s !== '') {
        for (var k = 0; k < state.list.length; k++) if (state.list[k].id === s) start = k;
        if (/^\d+$/.test(String(s))) start = parseInt(s, 10) % state.list.length;
      } else if (opt.shuffle) {
        start = Math.floor(Math.random() * state.list.length);
      } else {
        var last = parseInt(store('rh.wp.idx'), 10);      // continue where we left off
        start = isNaN(last) ? 0 : (last + 1) % state.list.length;
      }
      show(start).then(schedule, schedule);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(); });
    },
    next: function () { if (state.list.length) show((state.idx + 1) % state.list.length).then(schedule, schedule); },
    /* Idle mode: a longer interval (restarts the countdown from now; the current photo stays). */
    setInterval: function (sec) {
      if (!state.opt || !(sec >= 0) || sec === state.opt.intervalSec) return;
      state.opt.intervalSec = sec; if (state.list.length) schedule();
    },
    get intervalSec() { return state.opt ? state.opt.intervalSec : 0; },
    setMotion: function (on) {
      state.motion = !!on;
      document.body.classList.toggle('wp-still', !on);
      document.body.classList.toggle('wp-motion', !!on);
      if (state.front && state.ready) startKb(state.front, state.idx);
    },
    addGlass: addGlass,
    placeGlass: function (el) { if (el) { if (el.__bk) placeGlass(el.__bk); } else { glass = glass.filter(function (g) { return document.body.contains(g.el); }); glass.forEach(placeGlass); } },
    get motion() { return state.motion; },
    get current() { return state.list[state.idx]; }
  };
})();
