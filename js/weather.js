/* RH_Weather: current conditions + the next 2 days for Ambient, from Open-Meteo (free, no key).
 * Cached in localStorage ('rh.wx'), refreshed every weather.refreshMin, silent on failure: no data -> block hidden.
 * Chromium-76 safe. */
(function () {
  'use strict';
  var W = (window.RH_CONFIG || {}).weather || {};
  function jget(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function url() {
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + W.lat + '&longitude=' + W.lon +
      '&current=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min' +
      '&temperature_unit=fahrenheit&timezone=' + encodeURIComponent(W.timezone || 'America/Los_Angeles') + '&forecast_days=3';
  }
  function get(cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url(), true); x.timeout = 8000;
    x.onload = function () { if (x.status === 200) { try { return cb(JSON.parse(x.responseText)); } catch (e) {} } cb(null); };
    x.onerror = x.ontimeout = function () { cb(null); };
    try { x.send(); } catch (e) { cb(null); }
  }
  /* WMO weather codes -> [label, icon] */
  function cond(code, day) {
    var c = +code;
    if (c === 0) return ['Clear', day ? 'sun' : 'moon'];
    if (c === 1) return ['Mostly clear', day ? 'sun' : 'moon'];
    if (c === 2) return ['Partly cloudy', day ? 'psun' : 'pmoon'];
    if (c === 3) return ['Cloudy', 'cloud'];
    if (c === 45 || c === 48) return ['Fog', 'fog'];
    if (c >= 51 && c <= 57) return ['Drizzle', 'rain'];
    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return [c >= 80 ? 'Showers' : 'Rain', 'rain'];
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ['Snow', 'snow'];
    if (c >= 95) return ['Thunderstorms', 'storm'];
    return ['', 'cloud'];
  }
  var S = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  var CLOUD = '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 11.1 3.5 3.5 0 0 0 7 18z"/>';
  var ICONS = {
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
    psun: '<path d="M8.5 3.5v1.6M3.5 8.5h1.6M5 5l1.1 1.1M12 5l-1.1 1.1"/><path d="M5.6 11.2A3.5 3.5 0 0 1 11.6 7"/>' + CLOUD,
    pmoon: '<path d="M10.5 3.8A4.6 4.6 0 0 0 5 9.6"/>' + CLOUD,
    cloud: CLOUD,
    fog: '<path d="M4 9h16M6 13h12M4 17h16"/>',
    rain: CLOUD.replace('18h', '15h').replace('0 0 7 18z', '0 0 7 15z') + '<path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/>',
    snow: CLOUD.replace('18h', '15h').replace('0 0 7 18z', '0 0 7 15z') + '<path d="M9 19h.01M13 20h.01M17 19h.01"/>',
    storm: CLOUD.replace('18h', '15h').replace('0 0 7 18z', '0 0 7 15z') + '<path d="M13 15l-2 3.5h3l-2 3.5"/>'
  };
  function icon(k) { return '<svg class="wx-ico" viewBox="0 0 24 24" ' + S + ' aria-hidden="true">' + (ICONS[k] || ICONS.cloud) + '</svg>'; }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function render(el) {
    var c = jget('rh.wx');
    var fresh = c && c.d && c.d.current && Date.now() - c.t < (W.maxAgeHours || 3) * 36e5;
    if (!fresh) { el.innerHTML = ''; el.className = 'wx'; return false; }
    var d = c.d, cur = cond(d.current.weather_code, d.current.is_day !== 0), html = '';
    html += '<div class="wx-now">' + icon(cur[1]) + '<span class="wx-t">' + Math.round(d.current.temperature_2m) + '&deg;</span>' +
      '<span class="wx-c">' + cur[0] + '</span></div>';
    var dl = d.daily || {}, times = dl.time || [], today = localISO(), days = [];
    for (var i = 0; i < times.length && days.length < 2; i++) {
      if (times[i] <= today) continue;                               // next 2 days only (ISO dates compare as strings)
      if (dl.temperature_2m_max[i] == null || dl.temperature_2m_min[i] == null) continue;
      var dt = new Date(times[i] + 'T12:00:00'), dc = cond(dl.weather_code[i], true);
      days.push('<div class="wx-d"><span class="wx-dn">' + DAYS[dt.getDay()] + '</span>' + icon(dc[1]) +
        '<span class="wx-hi">' + Math.round(dl.temperature_2m_max[i]) + '&deg;</span><span class="wx-lo">' + Math.round(dl.temperature_2m_min[i]) + '&deg;</span></div>');
    }
    if (days.length) html += '<div class="wx-days">' + days.join('') + '</div>';
    el.innerHTML = html; el.className = 'wx on';
    return true;
  }
  function localISO() { var n = new Date(), m = n.getMonth() + 1, d = n.getDate(); return n.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d; }
  var timer = null;
  function update(el) {
    var c = jget('rh.wx'), every = (W.refreshMin || 30) * 6e4;
    render(el);
    if (c && Date.now() - c.t < every) { clearTimeout(timer); timer = setTimeout(function () { update(el); }, every - (Date.now() - c.t) + 1000); return; }
    get(function (d) {
      if (d && d.current && typeof d.current.temperature_2m === 'number') {
        var today = (d.current.time || '').slice(0, 10) || localISO();
        jset('rh.wx', { t: Date.now(), today: today, d: d });
      }
      render(el);
      clearTimeout(timer); timer = setTimeout(function () { update(el); }, d ? every : 5 * 6e4);   // failed: retry in 5 min, stay hidden/old
    });
  }
  window.RH_Weather = {
    start: function (el) { if (!el || W.enabled === false) return; update(el); },
    render: function (el) { return render(el); }
  };
})();
