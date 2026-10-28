/* Lightweight vector/typographic marks (no bitmap assets, no network).
 * These are stylised stand-ins, not official logos. Drop real artwork into
 * img/<key>.png and set RH_LOGO_IMAGES[key] = 'img/<key>.png' to override. */
window.RH_LOGO_IMAGES = {};
window.RH_LOGOS = {
  youtube:
    '<div class="mk mk-yt"><svg viewBox="0 0 120 84" class="mk-yt-ico"><rect x="0" y="0" width="120" height="84" rx="22" fill="#ff1f1f"/>' +
    '<path d="M48 24 L82 42 L48 60 Z" fill="#fff"/></svg><span>YouTube</span></div>',
  netflix: '<div class="mk mk-netflix">NETFLIX</div>',
  hbomax: '<div class="mk mk-hbo"><b>HBO</b><i>max</i></div>',
  prime:
    '<div class="mk mk-prime"><span class="p1">prime</span><span class="p2">video</span>' +
    '<svg viewBox="0 0 100 20" class="smile"><path d="M4 4 Q50 22 92 6" stroke="#1fa3ff" stroke-width="5" fill="none" stroke-linecap="round"/>' +
    '<path d="M84 2 L95 5 L89 14" stroke="#1fa3ff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>',
  hulu: '<div class="mk mk-hulu">hulu</div>',
  appletv:
    '<div class="mk mk-atv"><svg viewBox="0 0 40 48" class="mk-apple"><path fill="#f2f4f7" d="M33 25.6c0-5.3 4.3-7.8 4.5-8-2.5-3.6-6.3-4.1-7.6-4.1-3.2-.3-6.3 1.9-7.9 1.9-1.7 0-4.2-1.9-6.9-1.8-3.5.1-6.8 2.1-8.6 5.3-3.7 6.4-.9 15.8 2.6 21 1.8 2.5 3.8 5.3 6.5 5.2 2.6-.1 3.6-1.7 6.8-1.7 3.1 0 4.1 1.7 6.8 1.6 2.8 0 4.6-2.5 6.3-5.1 2-2.9 2.8-5.7 2.8-5.9-.1 0-5.3-2-5.3-8.4zM27.9 9.9c1.4-1.7 2.4-4.1 2.1-6.5-2.1.1-4.6 1.4-6 3.1-1.3 1.5-2.5 3.9-2.2 6.3 2.3.2 4.7-1.2 6.1-2.9z"/></svg><span>tv</span></div>',
  peacock:
    '<div class="mk mk-peacock"><span>peacock</span><em>' +
    '<i style="background:#fcb711"></i><i style="background:#f37021"></i><i style="background:#cc004c"></i>' +
    '<i style="background:#6460aa"></i><i style="background:#0089d0"></i><i style="background:#0db14b"></i></em></div>',
  disney: '<div class="mk mk-disney"><span>Disney</span><b>+</b></div>'
};
