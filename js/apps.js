/*
 * App catalogue for Samsung Tizen TVs.
 *
 * tizen.application.launch() takes the *Tizen application ID* (e.g. "9Ur5IzDKqV.TizenYouTube").
 * `tizenIds[0]` of every app is the ID read from a 2021 QN90A (US, Oct 2026) and is tried first;
 * the rest are community-documented fallbacks for other regions/firmware.
 * Launch order (see launchApp in app.js):
 *   1. RH_CONFIG.appIdOverrides, 2. tizenIds (verified first), 3. last working ID (cached),
 *   4. getAppsInfo() name match (exact `names` first, then `match`; helper entries whose name
 *      contains Worker / Service / dummy / BG are skipped), 5. storeIds.
 * Only IDs whose launch succeeded are cached; a cached ID that fails is deleted.
 *
 * Sources for fallbacks: github.com/tavicu/homebridge-samsung-tizen (#325, app-ID wiki),
 * xchwarze/samsung-tv-ws-api APPLICATIONS.md.
 */
window.RH_APPS = {
  youtube: {
    name: 'YouTube', color: '#ff2a2a',
    tizenIds: ['9Ur5IzDKqV.TizenYouTube'],
    storeIds: ['111299001912'],
    names: ['YouTube'],
    match: /^youtube$/i,
    confidence: 'verified'
  },
  netflix: {
    name: 'Netflix', color: '#e50914',
    tizenIds: ['org.tizen.netflix-app', 'org.tizen.netflixapp', 'RN1MCdNq8t.Netflix'],
    storeIds: ['3201907018807', '11101200001'],
    names: ['Netflix'],
    match: /^netflix/i,
    confidence: 'verified'
  },
  hbomax: {
    name: 'HBO Max', color: '#7b3cff',
    /* HBO Max -> Max (2023) -> HBO Max (2025). cj37Ni3qXM.HBONow is a stale stub on current firmware: removed. */
    tizenIds: ['5b8c3eb16b.BeamCTVDev'],
    storeIds: ['3202301029760', '3201601007230'],
    names: ['HBO Max', 'Max'],
    match: /^(hbo\s*max|max)$/i,
    confidence: 'verified'
  },
  prime: {
    name: 'Prime Video', color: '#1fa3ff',
    tizenIds: ['org.tizen.primevideo', 'evKhCgZelL.AmazonIgnitionLauncher2'],
    storeIds: ['3201910019365', '3201512006785'],
    names: ['Prime Video', 'Amazon Prime Video'],
    match: /prime\s*video/i,
    confidence: 'verified'
  },
  hulu: {
    name: 'Hulu', color: '#1ce783',
    tizenIds: ['LBUAQX1exg.Hulu'],
    storeIds: ['3201601007625'],
    names: ['Hulu'],
    match: /^hulu/i,
    confidence: 'verified'
  },
  appletv: {
    name: 'Apple TV', color: '#c9ced6',
    tizenIds: ['com.samsung.tv.aria-video', 'com.samsung.tv.ariavideo'],
    storeIds: ['3201807016597'],
    names: ['Apple TV', 'Apple TV+'],
    match: /^apple\s*tv\+?$/i,
    confidence: 'verified'
  },
  peacock: {
    name: 'Peacock', color: '#f5b400',
    tizenIds: ['gzcc4LRFBF.Peacock'],
    storeIds: ['3202006020991'],
    names: ['Peacock', 'Peacock TV'],
    match: /peacock/i,
    confidence: 'verified'
  },
  disney: {
    name: 'Disney+', color: '#1f6bff',
    tizenIds: ['MCmYXNxgcu.DisneyPlus'],
    storeIds: ['3201901017640', '3202009021709', '3202204027038'],
    names: ['Disney+', 'Disney Plus'],
    match: /^disney/i,
    confidence: 'verified'
  }
};

/* TMDB watch-provider IDs (US, subscription/ads tiers) -> app key. Rent/buy storefronts are ignored. */
window.RH_TMDB_PROVIDERS = { 8: 'netflix', 1796: 'netflix', 9: 'prime', 119: 'prime', 2100: 'prime', 337: 'disney',
  15: 'hulu', 1899: 'hbomax', 384: 'hbomax', 350: 'appletv', 386: 'peacock', 387: 'peacock' };

/* Maps a streaming provider name (TMDB / Trakt / JustWatch style) to an app key above. */
window.RH_PROVIDER_MAP = [
  [/netflix/i, 'netflix'],
  [/(hbo|^max$|max amazon channel)/i, 'hbomax'],
  [/(amazon|prime)/i, 'prime'],
  [/hulu/i, 'hulu'],
  [/apple/i, 'appletv'],
  [/peacock/i, 'peacock'],
  [/disney/i, 'disney'],
  [/youtube/i, 'youtube']
];
