/* RH_Saver: the picks screensaver (full-screen DOM overlay; js/app.js decides when it runs and owns the keys).
 * Full-screen TMDB backdrops of the current real picks ('original' or 'w1280', never smaller), crossfading with
 * opacity and drifting with a slow Ken Burns zoom (transform only), a big glass clock, and the title with its IMDb/RT
 * badges small at the bottom. Nothing is shown unless the first backdrop has actually loaded. Chromium-76 safe. */
(function () {
  'use strict';
  var CFG = window.RH_CONFIG || {}, S = CFG.screensaver || {};
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var el = null, imgs = [], front = 0, items = [], idx = 0, on = false, pending = false, slideT = null, clockT = null, gen = 0, cur = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /* TMDB image URL at screensaver size: only TMDB backdrops qualify; the size is rewritten to 'original' / 'w1280'. */
  function hires(u) {
    var size = S.backdropSize === 'w1280' ? 'w1280' : 'original';
    var m = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(w\d+|original)(\/[^?#]+\.(?:jpg|jpeg|png|webp))$/i.exec(u || '');
    return m ? m[1] + size + m[3] : null;
  }
  function build() {
    if (el) return;
    el = document.createElement('div'); el.className = 'sv'; el.id = 'saver'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="sv-ph"><img class="sv-img" alt=""><img class="sv-img" alt=""></div><div class="sv-shade"></div>' +
      '<div class="sv-clock"><div class="sv-time" id="svTime"></div><div class="sv-date" id="svDate"></div></div>' +
      '<div class="sv-meta" id="svMeta"><div class="sv-title" id="svTitle"></div><div class="sv-badges" id="svBadges"></div><div class="sv-hint" id="svHint"></div></div>';
    var stage = document.getElementById('stage') || document.body, dim = document.getElementById('dim');
    stage.insertBefore(el, dim || null);                 // under the idle dim layer, so long idle still dims it
    imgs = [].slice.call(el.querySelectorAll('.sv-img'));
  }
  function load(img, src) {
    return new Promise(function (res, rej) {
      img.onload = function () { if (img.decode) img.decode().then(res, res); else res(); };
      img.onerror = function () { rej(new Error('load')); };
      img.src = src;
    });
  }
  function clock() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes(), mm = (m < 10 ? '0' : '') + m;
    document.getElementById('svTime').innerHTML = (CFG.ui && CFG.ui.clock24h) ? (h < 10 ? '0' : '') + h + ':' + mm :
      ((h % 12) || 12) + ':' + mm + '<small>' + (h < 12 ? 'AM' : 'PM') + '</small>';
    document.getElementById('svDate').textContent = DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
    clearTimeout(clockT);
    if (on) clockT = setTimeout(clock, (60 - d.getSeconds()) * 1000 - d.getMilliseconds() + 30);
  }
  function meta(it, instant) {
    var m = document.getElementById('svMeta');
    function fill() {
      document.getElementById('svTitle').textContent = it.title;
      document.getElementById('svBadges').innerHTML = it.badges || '';
      document.getElementById('svHint').innerHTML = it.appName ? '<b>OK</b> Open in ' + esc(it.appName) : '<b>OK</b> Open';
      m.className = 'sv-meta in';
    }
    if (instant) return fill();
    m.className = 'sv-meta';
    setTimeout(function () { if (on) fill(); }, 600);
  }
  function kb(img, n) {
    img.style.animation = 'none'; void img.offsetWidth;
    var dur = ((S.slideSec || 14) * 1000 + (S.fadeMs || 2200) * 2) / 1000;
    img.style.animation = (n % 2 ? 'svkb2 ' : 'svkb1 ') + dur + 's linear forwards';
  }
  /* show items[i] (skipping any that fail to load); resolves false if none loads */
  function showAt(i, first, g, tries) {
    tries = tries || 0;
    if (g !== gen || !items.length || tries >= items.length) return Promise.resolve(false);
    var it = items[i % items.length], back = imgs[1 - front], prev = imgs[front];
    return load(back, it.src).then(function () {
      if (g !== gen) return false;
      idx = i % items.length; cur = it;
      kb(back, idx);
      back.className = 'sv-img' + (first ? ' on now' : ' on top');
      if (!first) prev.className = 'sv-img on';
      front = 1 - front;
      meta(it, first);
      setTimeout(function () { if (g === gen && imgs[front] === back) { back.className = 'sv-img on'; prev.className = 'sv-img'; prev.style.animation = 'none'; } }, (S.fadeMs || 2200) + 200);
      return true;
    }, function () { return showAt(i + 1, first, g, tries + 1); });
  }
  function schedule(g) {
    clearTimeout(slideT);
    if (items.length < 2) return;
    slideT = setTimeout(function () {
      if (g !== gen || !on) return;
      showAt(idx + 1, false, g).then(function () { if (g === gen && on) schedule(g); });
    }, (S.slideSec || 14) * 1000);
  }
  /* list: [{ title, backdrop, badges (HTML), appName, data }] -> Promise<boolean shown> */
  function start(list) {
    var ok = (list || []).map(function (x) { var s = hires(x.backdrop); if (!s) return null; var o = {}; for (var k in x) o[k] = x[k]; o.src = s; return o; }).filter(Boolean);
    if (!ok.length) return Promise.resolve(false);
    build();
    var g = ++gen; items = ok; idx = 0; on = false; pending = true;
    document.documentElement.style.setProperty('--sv-fade', (S.fadeMs || 2200) + 'ms');
    clock();
    return showAt(0, true, g).then(function (shown) {
      if (g !== gen) return false;
      pending = false;
      if (!shown) { stop(); return false; }
      on = true; clock();
      el.className = 'sv';                              // commit opacity 0, then fade in
      void el.offsetWidth;
      el.className = 'sv on';
      document.body.classList.add('saver-on');
      schedule(g);
      return true;
    });
  }
  function stop() {
    gen++; on = false; pending = false; cur = null; clearTimeout(slideT); clearTimeout(clockT);
    document.body.classList.remove('saver-on');
    if (!el) return;
    el.className = 'sv out';                            // quick fade back to the home
    setTimeout(function () { if (!on) { imgs.forEach(function (im) { im.className = 'sv-img'; im.style.animation = 'none'; im.removeAttribute('src'); }); } }, 500);
  }
  window.RH_Saver = { start: start, stop: stop, hires: hires,
    get on() { return on; }, get pending() { return pending; }, get current() { return cur; }, get count() { return items.length; } };
})();
