/* RH_Inputs: the TV's HDMI inputs and a Settings shortcut (dock, second row).
 *  - Ports: tizen.systeminfo.getPropertyValue('VIDEOSOURCE') -> { connected: [{type, number}], disconnected: [...] }.
 *    When the TV reports connection state, only HDMI ports with something plugged in are listed. If it returns
 *    sources without a usable split, the reported HDMI ports are listed by name. No API / an error -> nothing.
 *    Tizen's web API exposes no HDMI-CEC device names, so labels are "HDMI 1".."HDMI 4" (a name is only shown if a
 *    source object ever carries one). Plug/unplug: addPropertyValueChangeListener('VIDEOSOURCE').
 *  - Switching: tizen.tvwindow.setSource(source) (privilege http://tizen.org/privilege/tv.window), then the TV's
 *    viewer (org.tizen.tv-viewer) is launched to show it full screen; if that launch fails the launcher hides itself.
 *  - Settings: the platform 'setting' app control (no app id), then inputs.settingsAppIds (org.tizen.menu).
 * Everything is feature-detected and wrapped in try/catch. Desktop preview shows nothing, except ?inputs=mock
 * (tools/preview only), which returns clearly labelled fake ports. Chromium-76 safe. */
(function () {
  'use strict';
  var CFG = window.RH_CONFIG || {}, C = CFG.inputs || {};
  var IS_TIZEN = !!window.RH_IS_TIZEN;
  var MOCK = !IS_TIZEN && /[?&]inputs=mock\b/.test(location.search);
  function T() { return window.tizen || null; }
  function log() { if (CFG.debug && window.console) console.log.apply(console, ['[inputs]'].concat([].slice.call(arguments))); }

  function label(s) {
    var nm = s && (s.name || s.deviceName || s.label);                    // not in the documented API; used only if present
    return { title: 'HDMI ' + s.number, sub: nm && String(nm) !== 'HDMI ' + s.number ? String(nm) : '' };
  }
  function hdmi(list) {
    var out = [], seen = {};
    (list || []).forEach(function (s) {
      if (!s || String(s.type).toUpperCase() !== 'HDMI' || !(s.number >= 1)) return;
      if (seen[s.number]) return; seen[s.number] = 1;
      var l = label(s);
      out.push({ key: 'HDMI' + s.number, number: s.number, title: l.title, sub: l.sub, src: s });
    });
    return out.sort(function (a, b) { return a.number - b.number; });
  }
  /* done({ ports: [...], state: 'connected' | 'listed' | 'none' | 'mock', why }) */
  function detect(done) {
    if (MOCK) {
      return done({ state: 'mock', ports: [
        { key: 'HDMI1', number: 1, title: 'HDMI 1', sub: 'Mock', mock: true },
        { key: 'HDMI3', number: 3, title: 'HDMI 3', sub: 'Mock', mock: true }] });
    }
    var t = T(), si = t && t.systeminfo;
    if (!IS_TIZEN || C.enabled === false || !si || typeof si.getPropertyValue !== 'function') return done({ state: 'none', ports: [], why: 'no systeminfo' });
    var called = false;
    function once(r) { if (!called) { called = true; done(r); } }
    try {
      si.getPropertyValue('VIDEOSOURCE', function (v) {
        try {
          if (v && v.connected && v.connected.length !== undefined) return once({ state: 'connected', ports: hdmi(v.connected), all: hdmi([].concat(v.connected, v.disconnected || [])) });
          var any = v && (v.sources || v.list || v.disconnected);
          if (any && any.length) return once({ state: 'listed', ports: hdmi(any) });
          once({ state: 'none', ports: [], why: 'empty' });
        } catch (e) { once({ state: 'none', ports: [], why: String(e) }); }
      }, function (e) { log('VIDEOSOURCE error', e && e.name); once({ state: 'none', ports: [], why: e && e.name }); });
    } catch (e) { log('VIDEOSOURCE threw', e); once({ state: 'none', ports: [], why: String(e) }); }
    setTimeout(function () { once({ state: 'none', ports: [], why: 'timeout' }); }, 4000);
  }
  var watchId = null;
  function watch(cb) {
    if (MOCK || watchId !== null) return;
    try {
      var si = T() && T().systeminfo;
      if (si && si.addPropertyValueChangeListener) watchId = si.addPropertyValueChangeListener('VIDEOSOURCE', function () { detect(cb); });
    } catch (e) { log('VIDEOSOURCE listener', e); }
  }

  function launchId(id, ok, fail) {
    try { T().application.launch(id, ok, fail); } catch (e) { fail(e); }
  }
  /* done(ok, message) */
  function select(p, done) {
    done = done || function () {};
    if (!p) return done(false, '');
    if (p.mock) return done(false, 'Preview mock: no TV to switch');
    var t = T(), tw = t && t.tvwindow;
    if (!tw || typeof tw.setSource !== 'function') return done(false, 'This TV doesn\u2019t let apps switch inputs');
    function show() {
      launchId(C.viewerAppId || 'org.tizen.tv-viewer', function () { done(true); }, function () {
        try { t.application.getCurrentApplication().hide(); done(true); }       // the TV window shows the new source
        catch (e) { done(false, 'Switched, but couldn\u2019t show ' + p.title); }
      });
    }
    try {
      tw.setSource(p.src, show, function (e) { log('setSource failed', e && e.name); done(false, 'Couldn\u2019t switch to ' + p.title); }, 'MAIN');
    } catch (e) { log('setSource threw', e); done(false, 'Couldn\u2019t switch to ' + p.title); }
  }

  function settingsAvailable() { return MOCK || (IS_TIZEN && C.settings !== false && !!(T() && T().application)); }
  function openSettings(done) {
    done = done || function () {};
    if (MOCK) return done(false, 'Preview mock: no TV settings here');
    var t = T(), ids = (C.settingsAppIds || ['org.tizen.menu']).slice(), i = 0;
    function byId() {
      if (i >= ids.length) return done(false, 'Couldn\u2019t open Settings');
      launchId(ids[i++], function () { done(true); }, byId);
    }
    try {
      var ac = new t.ApplicationControl('http://tizen.org/appcontrol/operation/setting', null, null, null, []);
      t.application.launchAppControl(ac, null, function () { done(true); }, byId);
    } catch (e) { log('setting appcontrol', e); byId(); }
  }

  window.RH_Inputs = { detect: detect, watch: watch, select: select, openSettings: openSettings,
    settingsAvailable: settingsAvailable, get mock() { return MOCK; } };
})();
