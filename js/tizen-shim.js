/* Desktop preview: if `tizen` is missing (normal browser), install a mock so
 * the launcher renders and navigates with a keyboard. Launches just toast.
 * The mock app list mirrors the real TV; ?mock=alt swaps in unknown IDs and decoys so the
 * fallback chain (known IDs -> cached -> getAppsInfo name match -> store IDs) gets exercised. */
(function () {
  window.RH_IS_TIZEN = typeof window.tizen !== 'undefined' && !!window.tizen.application;
  if (window.RH_IS_TIZEN) return;

  // Mirrors the IDs read from the owner's QN90A (Oct 2026), plus helper/decoy entries that the
  // name matcher must skip. ?mock=alt hides the verified IDs so the name-match path is exercised.
  var real = [
    { id: '9Ur5IzDKqV.TizenYouTube', name: 'YouTube' },
    { id: 'org.tizen.netflix-app', name: 'Netflix' },
    { id: '5b8c3eb16b.BeamCTVDev', name: 'HBO Max' },
    { id: 'org.tizen.primevideo', name: 'Prime Video' },
    { id: 'LBUAQX1exg.Hulu', name: 'Hulu' },
    { id: 'com.samsung.tv.aria-video', name: 'Apple TV' },
    { id: 'gzcc4LRFBF.Peacock', name: 'Peacock' },
    { id: 'MCmYXNxgcu.DisneyPlus', name: 'Disney+' }
  ];
  var decoys = [
    { id: 'Decoy00001.HBOMaxWorker', name: 'HBO Max Worker' },
    { id: 'Decoy00002.MaxBG', name: 'Max BG' },
    { id: 'Decoy00003.PeacockSvc', name: 'Peacock Service' },
    { id: 'Decoy00004.NetflixDummy', name: 'Netflix dummy' },
    { id: 'Decoy00005.HBOMaxPromo', name: 'HBO Max Promo' }
  ];
  var alt = /[?&]mock=alt\b/.test(location.search);
  var fakeInstalled = alt ? decoys.concat([
    { id: 'Mock00HBOM.Max', name: 'HBO Max' },
    { id: 'Mock00Peac.Peacock', name: 'Peacock' },
    { id: 'Mock00Netf.Netflix', name: 'Netflix' }
  ]) : decoys.concat(real);
  function err(name, msg) { var e = new Error(msg); e.name = name; return e; }

  window.tizen = {
    __mock: true,
    ApplicationControl: function (operation, uri, mime, category, data) { this.operation = operation; this.uri = uri; },
    application: {
      launch: function (id, ok, fail) {
        setTimeout(function () {
          var hit = null;
          for (var i = 0; i < fakeInstalled.length; i++) if (fakeInstalled[i].id === id) hit = fakeInstalled[i];
          if (hit) {
            if (window.RH_toast) window.RH_toast('Preview · would open ' + hit.name + '  (' + id + ')');
            if (ok) ok();
          } else if (fail) fail(err('NotFoundError', 'No app ' + id));
        }, 30);
      },
      launchAppControl: function (ac, id, ok, fail) {
        setTimeout(function () {
          if (window.RH_toast) window.RH_toast('Preview · would open ' + (ac && ac.uri) + ' in ' + id);
          if (ok) ok();
        }, 30);
      },
      getAppsInfo: function (ok) { setTimeout(function () { ok(fakeInstalled.slice()); }, 10); },
      getCurrentApplication: function () {
        return { exit: function () { if (window.RH_toast) window.RH_toast('Preview · launcher would exit'); } };
      }
    },
    tvinputdevice: {
      registerKey: function () {},
      unregisterKey: function () {},
      getSupportedKeys: function () { return []; }
    }
  };
})();
