/*
 * Glass Home launcher — user configuration.
 * Everything here is optional. With no API keys the launcher runs offline: Tonight's Picks come from a dated,
 * real snapshot of IMDb's public charts and Continue Watching is hidden. No errors are ever shown on screen.
 *
 * NOTE: Tizen 6.0 ships a Chromium-76 class engine. Keep syntax ES2017-ish
 * (no ?. / ??, no flexbox `gap`, no `inset`, no `aspect-ratio`).
 */
window.RH_CONFIG = {
  ui: {
    /* Glass look (Red key cycles it):
     *  'baked': pre-blurred copies of each wallpaper are clipped into the dock/clock. Looks like frosted glass and
     *           costs nothing per frame. Default.
     *  'live' : real backdrop-filter blur (the old look; heavier, re-blurs whenever anything moves)
     *  'off'  : solid translucent panels
     * Old values 'auto'/'lite' map to 'baked', and 'full' maps to 'live'. */
    blur: 'baked',
    ambientMotion: false,     // drifting light blobs (only used when wallpapers are off)
    reducedMotion: false,     // true: Discover/dock changes are instant (also honoured from prefers-reduced-motion)
    greeting: true,
    userName: '',             // household or first name, e.g. 'Smith family' -> "Good evening, Smith family" ('' = just "Good evening")
    clock24h: false
  },

  /* Scenic wallpapers (bundled in images/wallpapers/, listed in js/wallpapers.js, credits in CREDITS.md).
   * Blue key (or "n" in the desktop preview) skips to the next one. */
  wallpaper: {
    enabled: true,            // false -> original dark gradient background
    intervalSec: 50,          // time each wallpaper stays up (0 = never rotate)
    fadeMs: 600,              // crossfade length (opacity only)
    motion: false,            // true: very slow Ken Burns zoom/pan (transform-only). Off for snappier input
    shuffle: false,           // false: continue in order from where the last session stopped
    showCaption: true,        // subtle location caption under the greeting
    showCredit: false,        // false: credit shown on demand (Yellow key or the small (i) next to the caption); see CREDITS.md
    /* Day/night preference (ids from js/wallpapers.js). After sunset rotation only uses `night` photos, by day only
     * `day` photos; an id in both (or in neither) fits any time. Empty lists = no preference (the tint still applies). */
    timeOfDay: {
      day: ['moraine-lake', 'matterhorn', 'maldives', 'geiranger', 'yosemite', 'yellowstone', 'na-pali', 'denali'],
      night: ['santorini', 'arashiyama', 'denali']
    }
  },

  back: {
    /* Back (10009) never exits by accident:
     *  'double': first Back returns focus to the first tile; on the first tile
     *            a second Back within windowMs exits (with an on-screen hint).
     *  'never' : Back never exits the launcher (use the Home/Exit key). */
    mode: 'double',
    windowMs: 2000
  },

  /* Home dock (keys refer to js/apps.js): `main` are the large icons, `extra` sit after a
   * subtle divider at the end of the same dock as smaller icons. */
  dock: {
    main: ['youtube', 'netflix', 'hbomax', 'prime', 'hulu', 'appletv'],
    extra: ['peacock', 'disney']
  },

  /* Discover (Up from the dock): Continue Watching (Trakt) + exactly 3 "Tonight's Picks".
   * Without keys the picks come from data/weekly.embed.js, a dated snapshot of IMDb's public Most Popular charts
   * (refresh with `node tools/fetch-weekly.js`). Preview with ?mock=1 for clearly labelled MOCK data. */
  discover: {
    enabled: true,
    hintSec: 12,              // the one-line hint above the dock on wake
    region: 'US',             // TMDB watch-provider region
    refreshHours: 12,         // live picks: cached last-good result paints instantly; refetched in the background when older
    snapshotMaxAgeDays: 21,   // hide snapshot picks once they are older than this
    detailLookups: 30,        // TMDB detail calls per refresh, split between movies and shows (Movies | Shows tabs)
    timeoutMs: 7000,
    upNextDays: 0,            // Up next: only shows watched within N days (0 = any age)
    resumeMax: 2,             // Resume Watching items (real unfinished Trakt content only; the row is hidden otherwise)
    artCacheMax: 18,          // posters kept as data: URLs so home paints with artwork even offline
    /* Platform pages (needs a TMDB key): Discover shows one streaming service at a time — Top 3 Shows / Top 3 Movies on
     * its US subscription catalogue, ranked by IMDb + Rotten Tomatoes (OMDb) and household taste. Left/Right on the
     * platform header, Channel Up/Down or past the first/last card slide to the previous/next service. */
    platformPages: true,
    platforms: ['netflix', 'hbomax', 'prime', 'hulu', 'appletv', 'peacock', 'disney'],   // default order (YouTube excluded)
    platformsByUsage: true,   // re-sort at start-up by how often each app was opened from this launcher (local count)
    platformRefreshHours: 12, // each service's list is cached; refetched in the background when older
    platformLookups: 8,       // TMDB detail + OMDb lookups per tab per service
    /* Picks are filtered first (light comedy, on one of the services in your dock, slot + runtime for tonight), then ranked by this
     * weighted score. Learned weights (kind/genre/selected) come from local use only: Open/Trailer and Not interested. */
    weights: { rating: 3, popularity: 2, fit: 1.5, tonight: 1.5, traktRec: 1.2, kind: 0.8, genre: 0.6, selected: 1.5, seen: 3 }
  },

  /* Weather in Ambient (Open-Meteo, free, no key). Cached in localStorage, refreshed every refreshMin; hidden when there is
   * no data or it is older than maxAgeHours (never placeholder numbers). */
  weather: {
    enabled: true,
    /* CHANGE THIS to your own location (decimal degrees; look it up on maps or open-meteo.com).
     * The default is only an example: San Jose, California. Also set timezone to your IANA zone. */
    lat: 37.3382, lon: -121.8863,   // example: San Jose, CA
    timezone: 'America/Los_Angeles',
    refreshMin: 30,
    maxAgeHours: 3
  },

  /* Dock: hidden in Ambient; Up/Down reveals it, Back or hideSec without a key hides it again. */
  dockAutoHideSec: 8,

  /* Idle / always-on: after `minutes` without a key press the UI fades out (fadeMs) and only the wallpaper stays,
   * rotating every intervalSec and dimmed in steps (brightness 1 = none). Any key wakes instantly; that key does nothing else.
   * keepScreenOn: turns the TV screensaver off while the launcher is in front (webapis.appcommon, Tizen only). */
  idle: {
    enabled: true,
    minutes: 10,
    fadeMs: 1500,
    dim: [{ afterMin: 10, brightness: 0.6 }, { afterMin: 30, brightness: 0.35 }],
    dimMs: 8000,              // how slowly each dim step happens
    intervalSec: 180,         // wallpaper interval while idle
    keepScreenOn: true
  },

  /* Day / night look: day between sunrise and sunset (Open-Meteo, same weather request: daily=sunrise,sunset;
   * fallback times when there's no forecast). Night = a slow opacity crossfade to a cool, dimmer tint over the
   * wallpaper and glass, softer text, and night-tagged wallpapers (wallpaper.timeOfDay). Re-checked every checkMin. */
  dayNight: {
    enabled: true,
    fallbackSunrise: '06:30',
    fallbackSunset: '18:30',
    checkMin: 3,
    fadeMs: 4000              // crossfade length for the tint, text and wallpaper switch
  },

  /* Picks screensaver: after `minutes` without a key on Ambient (never while Discover, the dock or an overlay is open),
   * full-screen TMDB backdrops of the current picks (backdropSize 'original' or 'w1280'; nothing smaller is used) with
   * a slow Ken Burns drift (transform only), a big glass clock and the title + IMDb/RT badges. OK opens the title
   * (same as "Open in <App>"); any other key just closes it. No real backdrops -> no screensaver (idle mode only). */
  screensaver: {
    enabled: true,
    minutes: 5,
    slideSec: 14,             // each backdrop
    fadeMs: 2200,             // crossfade between backdrops (opacity)
    backdropSize: 'original'
  },

  /* TV inputs + Settings (second dock row, Down from the apps). HDMI ports come from tizen.systeminfo VIDEOSOURCE
   * (only connected ones when the TV reports connection state) and switching uses tizen.tvwindow.setSource
   * (privilege tv.window). Settings opens Samsung's settings via the 'setting' app control (fallback: settingsAppIds). */
  inputs: {
    enabled: true,
    settings: true,
    viewerAppId: 'org.tizen.tv-viewer',      // shows the switched source full screen
    settingsAppIds: ['org.tizen.menu']       // tried in order if the setting app control fails
  },

  /* API keys (all free, all optional). See README "Discover data & keys".
   *  TMDB : https://www.themoviedb.org/settings/api  (v3 API key OR v4 read token). Gives live trending,
   *         where to watch (US), runtimes and YouTube trailers
   *  OMDb : https://www.omdbapi.com/apikey.aspx       (free tier 1,000/day). IMDb ratings for the live picks
   *  Trakt: https://trakt.tv/oauth/applications       client ID (PKCE app: no secret needed). Two ways to sign in:
   *         1) Before packaging (works): tools/trakt-link.sh (PKCE) saves tokens that make-dist bakes in below.
   *         2) On the TV: Discover → "Trakt not linked · Link" shows a code for trakt.tv/activate (device flow).
   *            Trakt documents client_secret as required for the device-token step, so with a PKCE app (no secret)
   *            this cannot finish; the status line then says so and points at step 1.
   * Keep these EMPTY in the repo. tools/make-dist.sh fills them into dist/js/config.js from the environment
   * variables TMDB_API_KEY, TMDB_READ_TOKEN, OMDB_API_KEY, TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET.        */
  keys: {
    tmdbApiKey: '',
    tmdbReadToken: '',
    omdbApiKey: '',
    traktClientId: '',
    traktClientSecret: '',
    traktUsername: '',
    traktRedirectUri: 'http://localhost',
    traktAccessToken: '',        // filled by make-dist from .secrets/trakt-tokens.json (tools/trakt-link.sh)
    traktRefreshToken: '',
    traktTokenCreatedAt: 0,
    traktTokenExpiresIn: 0
  },

  /* Voice assistant (js/voice.js): the relay runs on your Mac (relay/README.md). Set relay to your Mac's address, e.g.
   * 'http://YOUR-MAC-IP:8787' (give the Mac a DHCP reservation so it never changes). Empty, or not reachable -> the feature
   * stays completely hidden. Play/Pause on the remote opens the overlay; the phone page is the microphone. */
  voice: { enabled: true, relay: '' },

  /* Optional overrides of app IDs without editing apps.js, e.g.
   * { peacock: ['abcDEF1234.Peacock'] } — tried first. */
  appIdOverrides: {},

  debug: false
};
