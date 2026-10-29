/* RH_DayNight: day / night look.
 * Day = between today's sunrise and sunset from the weather forecast (Open-Meteo daily=sunrise,sunset, part of the one
 * existing weather request; RH_Weather.sun()). No forecast -> dayNight.fallbackSunrise/fallbackSunset (06:30/18:30).
 * Night sets body.night: a cool, dimmer tint over the wallpaper and glass and softer text, crossfaded slowly with
 * opacity only (CSS), and asks RH_Wallpaper to prefer night-tagged photos. Re-checked every dayNight.checkMin minutes,
 * when the forecast refreshes and when the launcher comes back to the front. ?tod=day|night forces a look (previews).
 * Chromium-76 safe (no ?. / ??). */
(function () {
  'use strict';
  var CFG = window.RH_CONFIG || {}, C = CFG.dayNight || {}, W = CFG.weather || {};
  var forced = (/[?&]tod=(day|night)\b/.exec(location.search) || [])[1] || null;
  var night = null, timer = null, last = { rise: 0, set: 0, src: '' };

  function hm(s, d) { var m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : d; }
  /* minutes after midnight now, in the weather timezone (America/Los_Angeles) when Intl supports it, else TV-local */
  var fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: W.timezone || 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { fmt = null; }
  function nowMins(d) {
    d = d || new Date();
    if (fmt && fmt.formatToParts) {
      try {
        var h = 0, m = 0;
        fmt.formatToParts(d).forEach(function (p) { if (p.type === 'hour') h = +p.value % 24; if (p.type === 'minute') m = +p.value; });
        return h * 60 + m;
      } catch (e) {}
    }
    return d.getHours() * 60 + d.getMinutes();
  }
  function times() {
    var s = null;
    try { s = window.RH_Weather && RH_Weather.sun ? RH_Weather.sun() : null; } catch (e) { s = null; }
    if (s) return { rise: s.rise, set: s.set, src: 'forecast' };
    return { rise: hm(C.fallbackSunrise, 390), set: hm(C.fallbackSunset, 1110), src: 'fallback' };
  }
  function isNight(d) {
    if (forced) return forced === 'night';
    var t = times(), m = nowMins(d); last = t;
    return m < t.rise || m >= t.set;
  }
  function apply(instant) {
    var n = isNight(), b = document.body;
    if (n === night) return;
    var first = night === null; night = n;
    var fade = C.fadeMs || 4000;
    document.documentElement.style.setProperty('--tod-fade', fade + 'ms');
    if (first || instant) b.classList.add('tod-instant');          // first paint: no crossfade
    b.classList.toggle('night', n); b.classList.toggle('day', !n);
    if (first || instant) { void b.offsetWidth; requestAnimationFrame(function () { requestAnimationFrame(function () { b.classList.remove('tod-instant'); }); }); }
    if (!first && window.RH_Wallpaper && RH_Wallpaper.setTimeOfDay) RH_Wallpaper.setTimeOfDay(n ? 'night' : 'day', fade);
  }
  function update() { try { apply(false); } catch (e) {} }
  function start() {
    if (C.enabled === false) return;
    apply(true);
    clearInterval(timer);
    timer = setInterval(update, Math.max(1, C.checkMin || 3) * 6e4);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) update(); });
  }
  window.RH_DayNight = {
    start: start, update: update,
    /* 'day' | 'night' | null (disabled), computed now; used for the wallpaper start */
    pref: function () { return C.enabled === false ? null : (isNight() ? 'night' : 'day'); },
    get night() { return night; },
    info: function () { var t = times(); return { night: night, forced: forced, rise: t.rise, set: t.set, src: t.src, now: nowMins() }; }
  };
})();
