/*
 * RH_Discover: data for the Discover state (Continue Watching + Tonight's Picks). Real data only:
 *   live     : TMDB trending/week + details/watch providers/videos (keys.tmdb*), IMDb ratings via OMDb (keys.omdbApiKey),
 *              Trakt watch history exclusion + playback progress (keys.trakt*). Cached in localStorage, refreshed weekly
 *              (picks pool) / on every Discover open (progress, at most every 10 min).
 *   snapshot : data/weekly.embed.js, a dated snapshot of IMDb's public Most Popular charts (tools/fetch-weekly.js).
 *              Where-to-watch is unknown there, so cards say so; hidden when older than discover.snapshotMaxAgeDays.
 *   mock     : ?mock=1 only. Fictional, labelled MOCK on screen.
 * Chromium-76 safe (no ?. / ??). Network errors are silent and keep the previous data.
 */
(function () {
  'use strict';
  var CFG = window.RH_CONFIG, K = CFG.keys || {}, D = CFG.discover || {};
  var MOCK = /[?&]mock=1\b/.test(location.search);
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function jget(k, d) { try { var v = JSON.parse(store(k)); return v == null ? d : v; } catch (e) { return d; } }
  function jset(k, v) { store(k, JSON.stringify(v)); }

  /* ---------- network ---------- */
  function getJSON(url, headers) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest(), done = false;
      x.open('GET', url, true); x.timeout = D.timeoutMs || 7000;
      Object.keys(headers || {}).forEach(function (h) { x.setRequestHeader(h, headers[h]); });
      x.onload = function () { done = true; if (x.status >= 200 && x.status < 300) { try { res(JSON.parse(x.responseText)); } catch (e) { rej(e); } } else rej(new Error('HTTP ' + x.status)); };
      x.onerror = x.ontimeout = function () { if (!done) rej(new Error('net')); };
      x.send();
    });
  }
  function postJSON(url, obj) {     // resolves { status, body } for any HTTP status (device-flow polling needs them)
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest();
      x.open('POST', url, true); x.timeout = D.timeoutMs || 7000; x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () { var b = null; try { b = JSON.parse(x.responseText); } catch (e) {} res({ status: x.status, body: b }); };
      x.onerror = x.ontimeout = function () { rej(new Error('net')); };
      x.send(JSON.stringify(obj));
    });
  }
  var TMDB = 'https://api.themoviedb.org/3';
  function hasTmdb() { return !!(K.tmdbApiKey || K.tmdbReadToken); }
  function tmdb(path) {
    var sep = path.indexOf('?') < 0 ? '?' : '&';
    if (K.tmdbReadToken) return getJSON(TMDB + path, { Authorization: 'Bearer ' + K.tmdbReadToken });
    return getJSON(TMDB + path + sep + 'api_key=' + encodeURIComponent(K.tmdbApiKey));
  }
  function hasTrakt() { return !!K.traktClientId; }
  /* Trakt OAuth device-code flow (TV-friendly: the screen shows a short code + trakt.tv/activate).
   * Tokens live in localStorage 'rh.trakt.auth' and are refreshed a day before they expire. */
  var TRAKT = 'https://api.trakt.tv';
  /* Tokens: localStorage first; else seeded from config (written at build time by tools/trakt-link.sh + make-dist). */
  function auth() {
    var a = jget('rh.trakt.auth', null);
    if (!a && K.traktAccessToken && K.traktRefreshToken) {
      a = { access_token: K.traktAccessToken, refresh_token: K.traktRefreshToken, created_at: K.traktTokenCreatedAt || 0, expires_in: K.traktTokenExpiresIn || 0 };
      jset('rh.trakt.auth', a);
    }
    return a;
  }
  function clientBody(o) { o.client_id = K.traktClientId; if (K.traktClientSecret) o.client_secret = K.traktClientSecret; return o; }   // PKCE apps have no secret
  function accessToken() { var a = auth(); return (a && a.access_token) || ''; }
  function refreshIfNeeded() {
    var a = auth();
    if (!a || !a.refresh_token) return Promise.resolve();
    if ((a.created_at + a.expires_in) * 1000 - Date.now() > 864e5) return Promise.resolve();
    return postJSON(TRAKT + '/oauth/token', clientBody({ refresh_token: a.refresh_token, redirect_uri: K.traktRedirectUri || 'http://localhost',
      grant_type: 'refresh_token' })).then(function (r) {
      if (r.status === 200 && r.body && r.body.access_token) jset('rh.trakt.auth', r.body);
      else if ((r.status === 401 || r.status === 400) && (a.created_at + a.expires_in) * 1000 < Date.now()) {   // only once it is unusable
        try { localStorage.removeItem('rh.trakt.auth'); } catch (e) {}
        setErr('Trakt sign-in expired');
      }
    }, function () {});
  }
  function trakt(path) {
    return refreshIfNeeded().then(function () {
      var h = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': K.traktClientId }, t = accessToken();
      if (t) h.Authorization = 'Bearer ' + t;
      return getJSON(TRAKT + path, h);
    });
  }
  function setErr(m) { if (m) store('rh.trakt.err', m); else try { localStorage.removeItem('rh.trakt.err'); } catch (e) {} }
  /* Check a stored token once in a while (and learn the username); a rejected token is dropped so the status is honest. */
  function verify() {
    var last = jget('rh.trakt.who', null);
    if (!accessToken() || (last && Date.now() - last.t < 6 * 36e5)) return Promise.resolve();
    return trakt('/users/settings').then(function (u) {
      jset('rh.trakt.who', { t: Date.now(), user: (u && u.user && u.user.username) || '' }); setErr('');
    }, function (e) {
      if (/HTTP 401/.test(String(e && e.message))) {
        try { localStorage.removeItem('rh.trakt.auth'); localStorage.removeItem('rh.trakt.who'); } catch (x) {}
        setErr('Trakt rejected the saved sign-in');
      }
    });
  }
  var MAC = 'run tools/trakt-link.sh on your Mac';
  var flow = null;
  var traktAuth = {
    /* 'unconfigured' (no client id/secret in config) | 'available' (can connect) | 'connected' */
    status: function () { return !hasTrakt() ? 'unconfigured' : accessToken() ? 'connected' : 'available'; },
    /* { state: 'unconfigured'|'linked'|'not-linked', user, err } for the one-line status in Discover */
    info: function () {
      var st = traktAuth.status(), who = jget('rh.trakt.who', null);
      return { state: st === 'connected' ? 'linked' : st === 'available' ? 'not-linked' : 'unconfigured',
        user: (st === 'connected' && who && who.user) || '', err: st === 'available' ? store('rh.trakt.err') || '' : '' };
    },
    verify: verify,
    historyCount: function () { return historyCount(); },
    /* onCode({ code, url, expiresAt }) once; onDone(ok, reason) at the end. Calling again restarts. */
    start: function (onCode, onDone) {
      if (flow) flow.cancelled = true;
      var me = flow = { cancelled: false };
      postJSON(TRAKT + '/oauth/device/code', { client_id: K.traktClientId }).then(function (r) {
        if (me.cancelled) return;
        if (r.status !== 200 || !r.body || !r.body.device_code) return onDone(false, 'Trakt said ' + r.status);
        var b = r.body, interval = (b.interval || 5) * 1000, until = Date.now() + (b.expires_in || 600) * 1000;
        onCode({ code: b.user_code, url: (b.verification_url || 'https://trakt.tv/activate').replace(/^https?:\/\//, ''), expiresAt: until });
        (function poll() {
          setTimeout(function () {
            if (me.cancelled) return;
            if (Date.now() > until) { setErr('TV sign-in did not finish \u00b7 ' + MAC); return onDone(false, 'Code expired. If you approved it, ' + MAC); }
            postJSON(TRAKT + '/oauth/device/token', clientBody({ code: b.device_code })).then(function (t) {
              if (me.cancelled) return;
              if (t.status === 200 && t.body && t.body.access_token) {                  // token stored here, and only here
                jset('rh.trakt.auth', t.body); setErr(''); try { localStorage.removeItem('rh.trakt.who'); localStorage.removeItem('rh.dsc.cw'); } catch (e) {}
                flow = null; return onDone(true);
              }
              if (t.status === 400) return poll();                       // still waiting for the user
              if (t.status === 429) { interval += 1000; return poll(); }  // slow down
              flow = null;
              var why = { 404: 'Invalid code', 409: 'Code already used', 410: 'Code expired', 418: 'Denied on trakt.tv',
                401: 'This Trakt app can\u2019t finish TV sign-in \u00b7 ' + MAC, 403: 'This Trakt app can\u2019t finish TV sign-in \u00b7 ' + MAC }[t.status] || 'Trakt said ' + t.status;
              setErr(why); onDone(false, why);
            }, function () { poll(); });
          }, interval);
        })();
      }, function () { onDone(false, 'No connection to Trakt'); });
    },
    cancel: function () { if (flow) flow.cancelled = true; flow = null; },
    disconnect: function () { try { ['rh.trakt.auth', 'rh.dsc.cw', 'rh.trakt.who', 'rh.trakt.err'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} }
  };

  /* ---------- user state (all local): not interested / shown / selected / preferences ---------- */
  function dismissed() { return jget('rh.dsc.dismissed', {}); }
  function shown() { return jget('rh.dsc.shown', {}); }
  function markShown(ids) {
    var s = shown(), now = Date.now(), cut = now - 14 * 864e5;
    Object.keys(s).forEach(function (k) { if (s[k] < cut) delete s[k]; });
    ids.forEach(function (id) { s[id] = now; }); jset('rh.dsc.shown', s);
  }
  /* rh.dsc.prefs: { kinds: { tv, movie }, genres: { Comedy: n, ... }, sel: { id: ts } } — small learned nudges only */
  function prefs() { var p = jget('rh.dsc.prefs', null) || {}; p.kinds = p.kinds || { tv: 0, movie: 0 }; p.genres = p.genres || {}; p.sel = p.sel || {}; return p; }
  function learn(t, w) {
    var p = prefs(); p.kinds[t.kind] = (p.kinds[t.kind] || 0) + w;
    (t.genres || []).forEach(function (g) { p.genres[g] = Math.max(-10, Math.min(10, (p.genres[g] || 0) + w)); });
    return p;
  }
  function selected(t) { if (!t || !t.id) return; var p = learn(t, 1); p.sel[t.id] = Date.now(); jset('rh.dsc.prefs', p); }
  function dismiss(id, t) {
    var d = dismissed(); d[id] = Date.now(); jset('rh.dsc.dismissed', d);
    if (t) jset('rh.dsc.prefs', learn(t, -0.5));
  }

  /* ---------- context ---------- */
  function context(now) {
    now = now || new Date();
    var h = now.getHours(), day = now.getDay();            // 0 Sun .. 6 Sat
    // Weeknight = an evening followed by a work day (Sun-Thu); late = after 9 pm.
    var weeknight = day >= 0 && day <= 4 && h >= 17, weekend = !weeknight && (day === 5 || day === 6 || (day === 0 && h < 17));
    return { hour: h, late: h >= 21 || h < 4, weeknight: weeknight || (h < 4 && day >= 1 && day <= 5), weekend: weekend };
  }
  function subline(ctx) {
    if (ctx.late) return 'Something light before bed?';
    if (ctx.hour >= 17) return ctx.weekend ? 'A movie night, maybe?' : 'Something easy for tonight?';
    if (ctx.hour < 12) return 'A few picks for later today';
    return 'Saved a few picks for tonight';
  }
  function hint(n) { return n === 1 ? '1 pick for tonight' : n + ' picks for tonight'; }

  /* ---------- scoring ---------- */
  var DARK = ['Horror', 'Thriller', 'Crime', 'War', 'War & Politics'];
  function has(g, list) { for (var i = 0; i < list.length; i++) if (g.indexOf(list[i]) >= 0) return true; return false; }
  /* Every pick must be a light title: Comedy (Family/Romance may be secondary), no anime, no dark/action lead genre. */
  var BAD_LEAD = ['Action', 'Action & Adventure', 'Crime', 'Horror', 'Thriller', 'War', 'War & Politics'];
  var NEVER = ['Documentary', 'Talk', 'News', 'Reality', 'Horror', 'Thriller', 'Crime', 'War', 'War & Politics'];
  function light(t) {
    var g = t.genres || [];
    if (!has(g, ['Comedy'])) return false;
    if (BAD_LEAD.indexOf(g[0]) >= 0 || has(g, NEVER)) return false;
    if (has(g, ['Animation'])) {                       // animation only when it's non-Japanese family comedy
      if (t.lang === 'ja' || !has(g, ['Family'])) return false;
    }
    if (t.lang === 'ja') return false;                 // no anime / J-drama in "something light" slots
    return true;
  }
  /* Step 1 — hard filters, BEFORE any ranking: light genre, slot fit and runtime for tonight.
   * Step 2 — a weighted preference score (config discover.weights); a high IMDb rating alone never wins a slot. */
  function rtIn(t, a, b) { return !t.runtimeMin || (t.runtimeMin >= a && t.runtimeMin <= b); }   // unknown: only reachable offline (see eligible)
  var SLOTS = [
    { id: 'laugh', label: 'Easy Laugh',                   // sitcom / comedy series, 20-35 min episodes
      ok: function (t, ctx) { return t.kind === 'tv' ? rtIn(t, 18, 36) :
        ctx.kind === 'movie' && t.genres[0] === 'Comedy' && rtIn(t, 70, ctx.weeknight ? 115 : 135); },
      fit: function (t) { return (t.genres[0] === 'Comedy' ? 1 : 0) + (t.genres.length === 1 ? 0.3 : 0) - (has(t.genres, ['Drama', 'Mystery']) ? 0.7 : 0); } },
    { id: 'feel', label: 'Feel-Good Tonight',             // warm comedy / family / romance, movie or series
      ok: function (t, ctx) { return !has(t.genres, ['Mystery', 'Sci-Fi & Fantasy', 'Science Fiction']) &&
        (t.kind === 'tv' ? rtIn(t, 18, 50) : rtIn(t, 70, ctx.weeknight ? 110 : 135)); },
      fit: function (t) { return (has(t.genres, ['Family', 'Romance']) ? 1 : 0) + (has(t.genres, ['Music', 'Musical']) ? 0.3 : 0) - (has(t.genres, ['Drama']) ? 0.3 : 0); } },
    { id: 'trend', label: 'Trending & Worth It',          // trending this week AND passes the same filters
      ok: function (t, ctx) { return (t.trending === undefined ? t.rank <= 15 : !!t.trending) && (t.rating || 0) >= 7 &&
        (t.kind === 'tv' ? rtIn(t, 18, ctx.weeknight ? 45 : 60) : rtIn(t, 70, ctx.weeknight ? 110 : 150)); },
      fit: function (t) { return Math.max(0, 41 - (t.trendRank || t.rank)) / 40; } }
  ];
  /* Movies / Shows tabs: when one of the 3 slots has nothing of that kind, this fills it (same light filters, sane runtime). */
  var MORE = { id: 'more', label: 'Worth a Look',
    ok: function (t, ctx) { return t.kind === 'tv' ? rtIn(t, 18, 60) : rtIn(t, 70, ctx.weeknight ? 120 : 150); },
    fit: function (t) { return (t.rating || 0) >= 7 ? 0.5 : 0; } };
  var WD = { rating: 3, popularity: 2, fit: 1.5, tonight: 1.5, traktRec: 1.2, kind: 0.8, genre: 0.6, selected: 1.5, seen: 3 };
  function weights() { var w = {}, c = D.weights || {}; Object.keys(WD).forEach(function (k) { w[k] = typeof c[k] === 'number' ? c[k] : WD[k]; }); return w; }
  function eligible(t, slot, ctx, st) {
    if (!light(t)) return false;
    if (st.liveProviders && !t.app) return false;                            // live data: must be on one of our services
    if (!t.runtimeMin && (st.liveProviders || slot.id === 'laugh')) return false;   // unknown runtime: only offline, never "Easy Laugh"
    return slot.ok(t, ctx);
  }
  function score(t, slot, ctx, st) {
    if (!eligible(t, slot, ctx, st)) return -1e9;
    var W = st.w, s = 0, rt = t.runtimeMin || 0;
    var q = t.rating ? Math.max(0, Math.min(1, (t.rating - 6) / 3)) : 0.25;   // 6.0 -> 0, 9.0 -> 1
    if (t.rating && t.ratingVotes && t.ratingVotes < 2000) q *= 0.6;           // too few votes to trust
    if (t.ratingSource === 'IMDb' && t.rating < 7) q *= 0.5;                   // prefer IMDb >= 7.0
    s += W.rating * q;
    s += W.popularity * (1 - Math.min(t.rank || 60, 60) / 60);
    s += W.fit * slot.fit(t);
    var tonight = 0;                                                           // weeknights: 20-40 min episodes
    if (ctx.weeknight) tonight = t.kind === 'tv' ? (rt >= 20 && rt <= 40 ? 1 : 0.3) : -0.6;
    else if (ctx.weekend) tonight = t.kind === 'movie' ? 0.6 : 0.3;            // weekends: movies welcome
    if (ctx.late && rt > 60) tonight -= 0.5;
    s += W.tonight * tonight;
    if (t.traktRec) s += W.traktRec;                                           // Trakt recommends it for you
    var p = st.prefs, kt = (p.kinds.tv || 0) - (p.kinds.movie || 0), kp = kt / (Math.abs(kt) + 4);   // learned movie-vs-episode lean
    s += W.kind * (t.kind === 'tv' ? kp : -kp);
    var gs = 0, gn = 0;
    (t.genres || []).forEach(function (g) { var v = p.genres[g]; if (v) { gs += v / (Math.abs(v) + 3); gn++; } });
    if (gn) s += W.genre * gs / gn;
    if (p.sel[t.id]) s -= W.selected;                                          // already opened it from here
    if (st.shown[t.id]) s -= W.seen * Math.max(0, 1 - (Date.now() - st.shown[t.id]) / (5 * 864e5));   // seen on screen recently
    return s;
  }
  /* ctx.kind ('movie' | 'tv'): one tab of Discover; only that kind, still 3 slots (+ 'Worth a Look' filler). */
  function choose(pool, ctx, extraSkip) {
    var st = { shown: shown(), liveProviders: pool.liveProviders, prefs: prefs(), w: weights() };
    var gone = dismissed(), used = {}, out = [], watched = pool.watched || {}, hs = pool.historyShows || {};
    Object.keys(extraSkip || {}).forEach(function (k) { used[k] = 1; });
    var items = pool.items.filter(function (t) { return !gone[t.id] && !watched[t.id] && !hs[t.id] && (!ctx.kind || t.kind === ctx.kind); });   // never anything already watched
    /* Fill the most constrained slot first (trending), then laugh, then feel; show them in SLOTS order. */
    [2, 0, 1].forEach(function (k) {
      var slot = SLOTS[k], best = null, bs = -1e8;
      items.forEach(function (t) { if (used[t.id]) return; var s = score(t, slot, ctx, st); if (s > bs) { bs = s; best = t; } });
      if (best) { used[best.id] = 1; out.push({ k: k, slot: slot.id, label: slot.label, item: best }); }
    });
    while (ctx.kind && out.length < 3) {
      var mb = null, ms = -1e8;
      items.forEach(function (t) { if (used[t.id]) return; var s = score(t, MORE, ctx, st); if (s > ms) { ms = s; mb = t; } });
      if (!mb) break;
      used[mb.id] = 1; out.push({ k: 3 + out.length, slot: 'more', label: MORE.label, item: mb });
    }
    return out.sort(function (a, b) { return a.k - b.k; });
  }
  /* The exact picks last painted, if they are all still valid: home looks the same on every start (and offline). */
  function lastKey(kind) { return 'rh.dsc.last' + (kind ? '.' + kind : ''); }
  function lastPicks(pool, kind) {
    var L = jget(lastKey(kind), null); if (!L || L.fetchedAt !== pool.fetchedAt || L.mode !== pool.mode) return null;
    var gone = dismissed(), byId = {}, out = [];
    pool.items.forEach(function (t) { byId[t.id] = t; });
    for (var i = 0; i < L.picks.length; i++) {
      var t = byId[L.picks[i].id], slot = SLOTS.concat([MORE]).filter(function (s) { return s.id === L.picks[i].slot; })[0];
      if (!t || !slot || gone[t.id] || (pool.watched || {})[t.id] || (pool.historyShows || {})[t.id]) return null;
      out.push({ slot: slot.id, label: slot.label, item: t });
    }
    return out.length === 3 || (kind && out.length && out.length === L.picks.length) ? out : null;
  }

  /* ---------- artwork cache: the posters on screen as data: URLs, so home paints with art even offline ---------- */
  function artCache() { return jget('rh.dsc.art', {}); }
  function cacheArt(urls) {
    if (!window.FileReader) return;
    var c = artCache(), todo = urls.filter(function (u) { return u && !c[u] && /^https:/.test(u); });
    todo.forEach(function (u) {
      var x = new XMLHttpRequest();
      x.open('GET', u, true); x.responseType = 'blob'; x.timeout = D.timeoutMs || 7000;
      x.onload = function () {
        if (x.status !== 200 || !x.response || x.response.size > 120000) return;
        var r = new FileReader();
        r.onload = function () {
          var cc = artCache(); cc[u] = { d: r.result, t: Date.now() };
          var ks = Object.keys(cc).sort(function (a, b) { return cc[b].t - cc[a].t; });
          ks.slice(D.artCacheMax || 9).forEach(function (k) { delete cc[k]; });     // keep the newest few
          jset('rh.dsc.art', cc);
        };
        r.readAsDataURL(x.response);
      };
      x.send();
    });
  }
  function art(u) { var c = u && artCache()[u]; return c ? c.d : u; }


  /* ---------- sources ---------- */
  function fromSnapshot() {
    var S = window.RH_WEEKLY_SNAPSHOT; if (!S || !S.fetchedAt) return null;
    var age = (Date.now() - Date.parse(S.fetchedAt)) / 864e5;
    if (age > (D.snapshotMaxAgeDays || 21)) return null;                    // too old to call it "this week"
    var items = [];
    [['shows', 'tv'], ['movies', 'movie']].forEach(function (p) {
      (S[p[0]] || []).forEach(function (t) {
        items.push({ id: 'imdb:' + t.imdbId, imdbId: t.imdbId, kind: p[1], title: t.title, year: t.year, rank: t.rank || 99,
          genres: t.genres || [], runtimeMin: t.runtimeMin, plot: t.plot, poster: t.poster,
          rating: t.imdbRating, ratingSource: t.imdbRating ? 'IMDb' : null, ratingVotes: t.votes, app: null, trailer: null });
      });
    });
    return { mode: 'snapshot', items: items, fetchedAt: S.fetchedAt, source: 'IMDb Most Popular', liveProviders: false };
  }

  var GENRES = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama',
    10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
    878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action & Adventure',
    10762: 'Kids', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics' };
  function providerApp(wp, subOnly) {   // subOnly: subscription (flatrate) only — used for picks
    var us = wp && wp.results && wp.results[D.region || 'US']; if (!us) return null;
    var list = subOnly ? (us.flatrate || []) : [].concat(us.flatrate || [], us.ads || [], us.free || []), map = window.RH_TMDB_PROVIDERS || {};
    var pref = (CFG.dock.main || []).concat(CFG.dock.extra || []), best = null;
    list.forEach(function (p) {
      var k = map[p.provider_id];
      if (!k) (window.RH_PROVIDER_MAP || []).forEach(function (m) { if (!k && m[0].test(p.provider_name || '')) k = m[1]; });
      if (k && (best === null || pref.indexOf(k) < pref.indexOf(best))) best = k;
    });
    return best;
  }
  /* Trakt: everything already watched (excluded from picks) + personal recommendations (extra candidates). */
  function traktHistory() {
    var none = { watched: {}, shows: {}, recs: [] };
    if (!hasTrakt() || (!accessToken() && !K.traktUsername)) return Promise.resolve(none);
    var authed = !!accessToken(), base = authed ? '/sync' : '/users/' + encodeURIComponent(K.traktUsername);
    function soft(p) { return trakt(p).catch(function () { return []; }); }
    return Promise.all([soft(base + '/watched/movies'), soft(base + '/watched/shows?extended=noseasons'), soft(base + '/history?limit=100'),
      authed ? soft('/recommendations/shows?limit=15&ignore_collected=true') : [], authed ? soft('/recommendations/movies?limit=10&ignore_collected=true') : []]).then(function (r) {
      var w = {}, s = {}, recs = [];
      function tm(o) { return o && o.ids && o.ids.tmdb; }
      (r[0] || []).forEach(function (x) { if (tm(x.movie)) w['tmdb:movie:' + x.movie.ids.tmdb] = 1; });
      (r[1] || []).forEach(function (x) { if (tm(x.show)) s['tmdb:tv:' + x.show.ids.tmdb] = 1; });
      (r[2] || []).forEach(function (x) {
        if (x.type === 'movie' && tm(x.movie)) w['tmdb:movie:' + x.movie.ids.tmdb] = 1;
        if (x.type === 'episode' && tm(x.show)) s['tmdb:tv:' + x.show.ids.tmdb] = 1;
      });
      (r[3] || []).forEach(function (x) { if (tm(x)) recs.push({ kind: 'tv', id: x.ids.tmdb, title: x.title, year: x.year }); });
      (r[4] || []).forEach(function (x) { if (tm(x)) recs.push({ kind: 'movie', id: x.ids.tmdb, title: x.title, year: x.year }); });
      return { watched: w, shows: s, recs: recs };
    });
  }
  function fromLive() {
    var now = Date.now();
    function soft(path) { return tmdb(path).catch(function () { return { results: [] }; }); }
    var provIds = Object.keys(window.RH_TMDB_PROVIDERS || {}).join('|');
    var disc = '&language=en-US&watch_region=' + (D.region || 'US') + '&with_watch_monetization_types=flatrate&with_watch_providers=' + provIds +
      '&sort_by=popularity.desc&without_genres=';
    var noTv = disc + '16,80,99,10759,10763,10764,10767,10768', noMovie = disc + '16,27,53,80,99,10752';
    return Promise.all([tmdb('/trending/all/week?language=en-US'), soft('/trending/tv/week?language=en-US'),
      soft('/trending/all/week?language=en-US&page=2'), soft('/trending/tv/week?language=en-US&page=2'), traktHistory(),
      soft('/discover/tv?with_genres=35&vote_count.gte=150' + noTv), soft('/discover/tv?with_genres=35&vote_count.gte=150&page=2' + noTv),
      soft('/discover/movie?with_genres=35&vote_count.gte=400' + noMovie), soft('/discover/movie?with_genres=35&vote_count.gte=400&page=2' + noMovie),
      soft('/trending/movie/week?language=en-US')]).then(function (r) {
      var seen = {}, cands = [], trendN = 0;
      function add(x, kindHint, trending) {
        var kind = x.media_type === 'tv' || x.media_type === 'movie' ? x.media_type : kindHint || (x.first_air_date !== undefined ? 'tv' : null);
        if (!kind) return; var id = 'tmdb:' + kind + ':' + x.id;
        if (seen[id]) { if (trending && !seen[id].trending) { seen[id].trending = true; seen[id].trendRank = ++trendN; } return; }
        var c = { id: id, tmdbId: x.id, kind: kind, title: x.title || x.name, year: parseInt((x.release_date || x.first_air_date || '').slice(0, 4), 10) || null,
          rank: cands.length + 1, trending: !!trending, trendRank: trending ? ++trendN : null, lang: x.original_language || null,
          genres: (x.genre_ids || []).map(function (g) { return GENRES[g]; }).filter(Boolean),
          plot: x.overview || null, poster: x.poster_path ? 'https://image.tmdb.org/t/p/w342' + x.poster_path : null,
          backdrop: x.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + x.backdrop_path : null,
          rating: x.vote_count >= 50 ? Math.round(x.vote_average * 10) / 10 : null, ratingSource: x.vote_count >= 50 ? 'TMDB' : null, ratingVotes: null };
        seen[id] = c; cands.push(c);
      }
      r[0].results.concat(r[1].results, r[2].results, r[3].results).forEach(function (x) { add(x, null, true); });
      (r[5].results || []).concat(r[6].results || []).forEach(function (x) { add(x, 'tv', false); });
      (r[9].results || []).forEach(function (x) { add(x, 'movie', true); });
      (r[7].results || []).concat(r[8].results || []).forEach(function (x) { add(x, 'movie', false); });
      var hist = r[4];
      (hist.recs || []).forEach(function (x) {                       // Trakt recommendations: genres come from the details lookup
        var id = 'tmdb:' + x.kind + ':' + x.id;
        if (seen[id]) { seen[id].traktRec = true; return; }
        add({ id: x.id, title: x.title, name: x.title, release_date: x.year ? x.year + '-01-01' : '' }, x.kind, false);
        seen[id].traktRec = true;
      });
      /* Only light candidates are worth a details lookup (providers, runtime, IMDb id): trending ones first. */
      var top = cands.filter(function (c) { return !hist.watched[c.id] && !hist.shows[c.id] && (light(c) || c.traktRec); })
        .sort(function (a, b) { return (b.trending || b.traktRec ? 1 : 0) - (a.trending || a.traktRec ? 1 : 0) || a.rank - b.rank; })
        .filter(function (c, i, a) {                                  // Movies and Shows tabs: half the lookups each (spare goes to the other)
          var n = D.detailLookups || 30, half = Math.ceil(n / 2), other = a.filter(function (x) { return x.kind !== c.kind; }).length;
          var mine = a.slice(0, i).filter(function (x) { return x.kind === c.kind; }).length;
          return mine < Math.max(half, n - Math.min(half, other));
        });
      return Promise.all(top.map(function (c) {
        return tmdb('/' + c.kind + '/' + c.tmdbId + '?language=en-US&append_to_response=watch/providers,external_ids,videos').then(function (d) {
          c.app = providerApp(d['watch/providers'], true);
          c.lang = d.original_language || c.lang;
          if (d.genres && d.genres.length) c.genres = d.genres.map(function (g) { return g.name; });   // authoritative order (lead genre first)
          if (!c.poster && d.poster_path) c.poster = 'https://image.tmdb.org/t/p/w342' + d.poster_path;
          if (!c.backdrop && d.backdrop_path) c.backdrop = 'https://image.tmdb.org/t/p/w780' + d.backdrop_path;
          if (!c.plot && d.overview) c.plot = d.overview;
          if (!c.rating && d.vote_count >= 50) { c.rating = Math.round(d.vote_average * 10) / 10; c.ratingSource = 'TMDB'; }
          c.runtimeMin = c.kind === 'movie' ? d.runtime || null : ((d.episode_run_time || [])[0] || (d.last_episode_to_air || {}).runtime || null);
          c.imdbId = d.imdb_id || (d.external_ids || {}).imdb_id || null;
          var v = ((d.videos || {}).results || []).filter(function (v) { return v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'); })[0];
          c.trailer = v ? v.key : null;
          return c;
        }, function () { return null; });
      })).then(function (list) {
        list = list.filter(function (c) { return c && light(c); });
        if (!K.omdbApiKey) return list;
        return Promise.all(list.map(function (c) {
          if (!c.imdbId || !c.app) return c;
          return getJSON('https://www.omdbapi.com/?i=' + c.imdbId + '&apikey=' + encodeURIComponent(K.omdbApiKey)).then(function (o) {
            var r = parseFloat(o.imdbRating);
            if (!isNaN(r)) { c.rating = r; c.ratingSource = 'IMDb'; c.ratingVotes = parseInt(String(o.imdbVotes || '').replace(/,/g, ''), 10) || null; }
            return c;
          }, function () { return c; });
        }));
      }).then(function (list) {
        var mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));   // Monday of this week
        var pool = { v: 2, mode: 'live', items: list, fetchedAt: new Date(now).toISOString(), weekOf: mon.toISOString(), liveProviders: true,
          watched: hist.watched, historyShows: hist.shows, omdb: !!K.omdbApiKey };
        if (list.length) jset('rh.dsc.live', pool);
        return pool;
      });
    });
  }
  function mockPool() {
    var g = [['MOCK · Office Hours', 'tv', ['Comedy'], 22, 'netflix', 8.1], ['MOCK · Sunny Side Bakery', 'movie', ['Comedy', 'Family'], 96, 'disney', 7.4],
      ['MOCK · Orbit', 'tv', ['Drama', 'Science Fiction'], 48, 'appletv', 8.6], ['MOCK · Small Talk', 'tv', ['Comedy'], 28, 'hulu', 7.8],
      ['MOCK · Paper Kites', 'movie', ['Romance', 'Comedy'], 104, 'prime', 7.1], ['MOCK · The Long Field', 'tv', ['Drama'], 55, 'hbomax', 8.3],
      ['MOCK · Weekend Pass', 'tv', ['Comedy', 'Family'], 30, 'peacock', 7.6]];
    return { mode: 'mock', fetchedAt: new Date().toISOString(), source: 'MOCK data (?mock=1)', liveProviders: true,
      items: g.map(function (x, i) { return { id: 'mock:' + i, kind: x[1], title: x[0], year: 2026, rank: i + 1, genres: x[2], runtimeMin: x[3], app: x[4],
        rating: x[5], ratingSource: 'MOCK', plot: 'Example synopsis for layout testing only. Not a real title.', poster: null, trailer: i === 2 ? 'MOCKKEY' : null }; }) };
  }

  /* ---------- Resume Watching (Trakt): only real unfinished content ----------
   *   1. paused playback (/sync/playback, < 95 %), newest first
   *   2. shows in progress: the next unwatched episode of a show watched in the last 45 days (/shows/:id/progress/watched)
   * Empty when nothing is unfinished — the row is then hidden and the status line says so. */
  function continueWatching() {
    if (MOCK) return Promise.resolve([
      { id: 'mockcw:1', title: 'MOCK · Office Hours', sub: 'S2 · E5 · "The Copier"', progress: 0.62, remainingMin: 9, app: 'netflix', mock: true },
      { id: 'mockcw:2', title: 'MOCK · Orbit', sub: 'Next · S1 · E3', progress: 0.25, remainingMin: null, app: 'appletv', mock: true }]);
    if (!hasTrakt() || !accessToken()) return Promise.resolve([]);   // needs a linked account
    var cached = jget('rh.dsc.cw', null), max = D.resumeMax || 2;
    if (cached && Date.now() - cached.t < 10 * 6e4) return Promise.resolve(cached.items);
    function withApp(it, kind, tid) {
      if (!tid || !hasTmdb()) return Promise.resolve(it);                      // provider unknown without TMDB
      return tmdb('/' + kind + '/' + tid + '/watch/providers').then(function (wp) { it.app = providerApp(wp); return it; }, function () { return it; });
    }
    function ep(e) { return 'S' + e.season + ' · E' + e.number + (e.title ? ' · \u201c' + e.title + '\u201d' : ''); }
    return verify().then(function () {
      return Promise.all([trakt('/sync/playback?extended=full'), trakt('/sync/watched/shows?extended=noseasons').catch(function () { return []; }),
        trakt('/sync/history?limit=1').catch(function () { return []; })]);
    }).then(function (r) {
      histN = (r[0] || []).length + (r[1] || []).length + (r[2] || []).length;   // any activity at all
      var play = (r[0] || []).filter(function (p) { return p.progress > 1 && p.progress < 95; })   // never show finished titles
        .sort(function (a, b) { return Date.parse(b.paused_at) - Date.parse(a.paused_at); }).slice(0, max);
      var items = play.map(function (p) {
        var isEp = p.type === 'episode', m = isEp ? p.episode : p.movie, show = isEp ? p.show : p.movie;
        var rt = (m && m.runtime) || (show && show.runtime) || null;
        return { it: { id: 'trakt:' + p.id, title: show.title, progress: p.progress / 100, sub: isEp ? ep(m) : (show.year ? String(show.year) : ''),
          remainingMin: rt ? Math.max(1, Math.round(rt * (1 - p.progress / 100))) : null, app: null, at: Date.parse(p.paused_at) },
          kind: isEp ? 'tv' : 'movie', tid: show.ids && show.ids.tmdb, key: show.ids && show.ids.trakt };
      });
      var have = {}; items.forEach(function (x) { have[x.key] = 1; });
      var recent = (r[1] || []).filter(function (w) { return w.show && w.show.ids && !have[w.show.ids.trakt] && Date.now() - Date.parse(w.last_watched_at) < 45 * 864e5; })
        .sort(function (a, b) { return Date.parse(b.last_watched_at) - Date.parse(a.last_watched_at); }).slice(0, 3);
      return Promise.all(recent.map(function (w) {
        return trakt('/shows/' + w.show.ids.trakt + '/progress/watched?hidden=false&specials=false').then(function (pg) {
          if (!pg || !pg.next_episode || !(pg.completed > 0) || pg.completed >= pg.aired) return null;
          return { it: { id: 'trakt:next:' + w.show.ids.trakt, title: w.show.title, progress: pg.completed / pg.aired, sub: 'Next \u00b7 ' + ep(pg.next_episode),
            remainingMin: null, app: null, at: Date.parse(w.last_watched_at) }, kind: 'tv', tid: w.show.ids.tmdb };
        }, function () { return null; });
      })).then(function (next) {
        var all = items.concat(next.filter(Boolean)).slice(0, max);
        return Promise.all(all.map(function (x) { return withApp(x.it, x.kind, x.tid); }));
      });
    }).then(function (items) { cwErr = false; jset('rh.dsc.cw', { t: Date.now(), items: items, hist: histN }); return items; },
      function () { cwErr = true; return cached ? cached.items : []; });
  }
  var histN = -1, cwErr = false;
  /* how much Trakt history the linked account has: n >= 0, -1 not checked yet, -2 Trakt unreachable */
  function historyCount() { var c = jget('rh.dsc.cw', null); return c && typeof c.hist === 'number' ? c.hist : cwErr ? -2 : -1; }

  /* ---------- Per-platform Top 3 (Discover carousel) ----------
   * One page per streaming service (dock order, re-sorted by how often each app is opened here). For each service and
   * tab: TMDB discover filtered to that service's US subscription catalogue (with_watch_providers + flatrate), light
   * genres first, then IMDb rating + votes and the Rotten Tomatoes critics score (both via OMDb) decide the order.
   * Cached per service in localStorage (rh.dsc.plat.<key>); stale after refreshHours; neighbours are prefetched. */
  var PROV = {};                       // app key -> [TMDB provider ids]
  (function () { var m = window.RH_TMDB_PROVIDERS || {}; Object.keys(m).forEach(function (id) { (PROV[m[id]] = PROV[m[id]] || []).push(id); }); })();
  var platOrder = null;
  function usage() { return jget('rh.usage', {}); }
  function noteLaunch(key) { var u = usage(); u[key] = (u[key] || 0) + 1; jset('rh.usage', u); }
  function platforms() {
    if (platOrder) return platOrder;
    var base = D.platforms || (CFG.dock.main || []).concat(CFG.dock.extra || []), u = usage();
    var list = base.filter(function (k) { return !!PROV[k]; });
    platOrder = list.map(function (k, i) { return { k: k, i: i, n: u[k] || 0 }; })
      .sort(function (a, b) { return D.platformsByUsage === false ? a.i - b.i : (b.n - a.n) || (a.i - b.i); }).map(function (x) { return x.k; });
    return platOrder;
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  /* quality 0..1: IMDb (votes-checked) blended with Rotten Tomatoes when OMDb has it; TMDB-only ratings count for less */
  function quality(t) {
    var q;
    if (t.ratingSource === 'IMDb' && t.rating) {
      q = clamp01((t.rating - 6) / 3);
      if (t.ratingVotes != null) q *= t.ratingVotes < 500 ? 0.3 : t.ratingVotes < 2000 ? 0.6 : 1;
    } else q = t.rating ? clamp01((t.rating - 6) / 3) * 0.5 : 0;
    if (t.rt != null) q = 0.6 * q + 0.4 * clamp01((t.rt - 60) / 40);
    return q;
  }
  function platScore(t, hist) {
    var p = prefs(), g = t.genres || [], gs = 0, gn = 0, s = 3 * quality(t);
    s += Math.max(0, 21 - (t.rank || 20)) / 20;                         // TMDB popularity on that service
    s += has(g, ['Comedy']) ? 1 : 0; s += has(g, ['Family', 'Romance']) ? 0.4 : 0; s -= g[0] === 'Drama' ? 0.3 : 0;
    g.forEach(function (x) { var v = p.genres[x]; if (v) { gs += v / (Math.abs(v) + 3); gn++; } });
    if (gn) s += 0.6 * gs / gn;
    if (shown()[t.id]) s -= 0.5;
    if (hist && hist.recs && hist.recs.some(function (r) { return 'tmdb:' + r.kind + ':' + r.id === t.id; })) s += 1.2;
    return s;
  }
  function okForHouse(t) {
    var g = t.genres || [];
    if (t.lang === 'ja' || has(g, NEVER)) return false;
    if (has(g, ['Animation']) && !has(g, ['Family'])) return false;
    if (BAD_LEAD.indexOf(g[0]) >= 0 && !has(g, ['Comedy'])) return false;
    return true;
  }
  var HIST_KEY = 'rh.dsc.hist';
  var histP = null;
  var histTok = null;
  function history() {                 // Trakt watched set, cached 6 h (shared by all platform pages)
    var tok = accessToken() || '';
    if (histP && histTok === tok) return histP;  // re-read once Trakt gets linked/unlinked
    histTok = tok;
    var c = jget(HIST_KEY, null);
    if (c && Date.now() - c.t < 6 * 36e5) return (histP = Promise.resolve(c.h));
    histP = traktHistory().then(function (h) { if (hasTrakt() && (accessToken() || K.traktUsername)) jset(HIST_KEY, { t: Date.now(), h: h }); return h; },
      function () { return { watched: {}, shows: {}, recs: [] }; });
    return histP;
  }
  function platKey(k) { return 'rh.dsc.plat.' + k; }
  function fetchPlatform(key) {
    var ids = PROV[key]; if (!ids) return Promise.reject(new Error('no provider'));
    function soft(path) { return tmdb(path).catch(function () { return { results: [] }; }); }
    var q = '&language=en-US&watch_region=' + (D.region || 'US') + '&with_watch_monetization_types=flatrate&with_watch_providers=' + ids.join('|') +
      '&sort_by=popularity.desc&include_adult=false&without_genres=';
    var tvNo = q + '16,80,99,10763,10764,10767,10768', mvNo = q + '16,27,53,80,99,10752';
    return Promise.all([soft('/discover/tv?with_genres=35&vote_count.gte=60' + tvNo), soft('/discover/tv?vote_count.gte=150' + tvNo),
      soft('/discover/movie?with_genres=35&vote_count.gte=250' + mvNo), soft('/discover/movie?vote_count.gte=500' + mvNo), history()]).then(function (r) {
      var hist = r[4] || {}, seen = {}, byKind = { tv: [], movie: [] };
      function add(x, kind, i) {
        var id = 'tmdb:' + kind + ':' + x.id; if (seen[id] || (hist.watched || {})[id] || (hist.shows || {})[id]) return;
        var c = { id: id, tmdbId: x.id, kind: kind, title: x.title || x.name, year: parseInt((x.release_date || x.first_air_date || '').slice(0, 4), 10) || null,
          rank: i + 1, lang: x.original_language || null, genres: (x.genre_ids || []).map(function (g) { return GENRES[g]; }).filter(Boolean),
          plot: x.overview || null, poster: x.poster_path ? 'https://image.tmdb.org/t/p/w342' + x.poster_path : null, app: key, popularity: x.popularity || 0,
          rating: x.vote_count >= 50 ? Math.round(x.vote_average * 10) / 10 : null, ratingSource: x.vote_count >= 50 ? 'TMDB' : null, ratingVotes: null, rt: null };
        if (!okForHouse(c)) return;
        seen[id] = c; byKind[kind].push(c);
      }
      [[0, 'tv'], [1, 'tv'], [2, 'movie'], [3, 'movie']].forEach(function (p) { ((r[p[0]] || {}).results || []).forEach(function (x, i) { add(x, p[1], i); }); });
      var n = D.platformLookups || 8, todo = [];
      ['tv', 'movie'].forEach(function (k) {
        todo = todo.concat(byKind[k].sort(function (a, b) { return (has(b.genres, ['Comedy']) ? 1 : 0) - (has(a.genres, ['Comedy']) ? 1 : 0) || a.rank - b.rank; }).slice(0, n));
      });
      return Promise.all(todo.map(function (c) {
        return tmdb('/' + c.kind + '/' + c.tmdbId + '?language=en-US&append_to_response=external_ids,videos').then(function (d) {
          if (d.genres && d.genres.length) c.genres = d.genres.map(function (g) { return g.name; });
          c.lang = d.original_language || c.lang;
          if (!c.poster && d.poster_path) c.poster = 'https://image.tmdb.org/t/p/w342' + d.poster_path;
          c.runtimeMin = c.kind === 'movie' ? d.runtime || null : ((d.episode_run_time || [])[0] || (d.last_episode_to_air || {}).runtime || null);
          c.seasons = c.kind === 'tv' ? d.number_of_seasons || null : null;
          c.imdbId = d.imdb_id || (d.external_ids || {}).imdb_id || null;
          var v = ((d.videos || {}).results || []).filter(function (v) { return v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'); })[0];
          c.trailer = v ? v.key : null;
          if (!okForHouse(c)) return null;
          if (!K.omdbApiKey || !c.imdbId) return c;
          return getJSON('https://www.omdbapi.com/?i=' + c.imdbId + '&apikey=' + encodeURIComponent(K.omdbApiKey)).then(function (o) {
            var ir = parseFloat(o.imdbRating);
            if (!isNaN(ir)) { c.rating = ir; c.ratingSource = 'IMDb'; c.ratingVotes = parseInt(String(o.imdbVotes || '').replace(/,/g, ''), 10) || null; }
            (o.Ratings || []).forEach(function (x) { if (x.Source === 'Rotten Tomatoes') { var p = parseInt(x.Value, 10); if (!isNaN(p)) c.rt = p; } });
            return c;
          }, function () { return c; });
        }, function () { return null; });
      })).then(function (list) {
        list = list.filter(Boolean);
        var res = { v: 1, key: key, fetchedAt: new Date().toISOString(), items: list, omdb: !!K.omdbApiKey, watched: hist.watched || {}, shows: hist.shows || {} };
        if (list.length) jset(platKey(key), res);
        return res;
      });
    });
  }
  var platInflight = {};
  function refreshPlatform(key) {
    if (!platInflight[key]) platInflight[key] = fetchPlatform(key).then(function (p) { delete platInflight[key]; return p.items.length ? p : null; },
      function () { delete platInflight[key]; return null; });
    return platInflight[key];
  }
  function platStale(c) { return !c || c.v !== 1 || Date.now() - Date.parse(c.fetchedAt) > (D.platformRefreshHours || D.refreshHours || 12) * 36e5; }
  function rankPlatform(pool, kind) {
    var gone = dismissed();
    return pool.items.filter(function (t) { return t.kind === kind && !gone[t.id] && !(pool.watched || {})[t.id] && !(pool.shows || {})[t.id] && okForHouse(t); })
      .map(function (t) { return { t: t, s: platScore(t) }; })
      .sort(function (a, b) { return b.s - a.s; }).slice(0, 3)
      .map(function (x, i) { return { slot: 'top', label: '#' + (i + 1), item: x.t }; });
  }
  function platformPicks(key, kind, cb, opt) {
    opt = opt || {};
    function deliver(p, bg) {
      var out = rankPlatform(p, kind);
      if (out.length) setTimeout(function () { cacheArt(out.map(function (o) { return o.item.poster; })); }, 1500);
      cb({ platform: key, kind: kind, mode: 'live', platformMode: true, fetchedAt: p.fetchedAt, omdb: p.omdb, picks: out, background: !!bg });
    }
    var c = jget(platKey(key), null);
    if (c && c.v === 1 && c.items.length) deliver(c);
    if (platStale(c) || opt.force) refreshPlatform(key).then(function (p) {
      if (p) deliver(p, !!c);
      else if (!c || !c.items.length) cb({ platform: key, kind: kind, mode: 'none', platformMode: true, failed: true, picks: [] });
    });
  }
  function prefetchPlatform(key) { if (PROV[key] && hasTmdb() && platStale(jget(platKey(key), null))) refreshPlatform(key); }

  /* ---------- public ---------- */
  var refreshing = null;
  function liveStale(c) { return !c || c.v !== 2 || Date.now() - Date.parse(c.fetchedAt) > (D.refreshHours || 12) * 36e5; }
  function refreshLive() {             // one background refresh at a time; resolves the new pool or null
    if (!refreshing) refreshing = fromLive().then(function (p) { refreshing = null; return p.items.length ? p : null; },
      function () { refreshing = null; return null; });
    return refreshing;
  }
  window.RH_Discover = {
    enabled: D.enabled !== false,
    mock: MOCK,
    context: context, subline: subline, hint: hint, slots: SLOTS,
    /* cb({ mode, source, fetchedAt, picks:[{slot,label,item}] }) — picks empty when there is no real data */
    /* Paints instantly from the last good result (live cache, else the dated snapshot), then — when keys are set and
     * the cache is older than refreshHours (or opt.force) — refreshes in the background and calls cb again. */
    picks: function (cb, opt) {
      opt = opt || {};
      /* opt.skip: ids not to show (everything shown this session on Refresh). opt.strict: never fall back to them —
       * the callback then gets { exhausted: true } with the best partial set instead of repeats. */
      function deliver(p, bg) {
        if (!p) return cb({ mode: 'none', picks: [] });
        var cx = context(opt.now); if (opt.kind) cx.kind = opt.kind;
        var out = !opt.skip && !opt.force && !bg ? lastPicks(p, opt.kind) : null, exhausted = false;
        if (!out) out = choose(p, cx, opt.skip);
        var full = opt.kind ? Math.min(3, p.items.filter(function (t) { return t.kind === opt.kind; }).length) : 3;
        if (opt.skip && out.length < full) {
          if (opt.strict) exhausted = !out.length;                  // a short tab may refresh to fewer cards; never repeats
          else out = choose(p, cx);
        }
        if (!exhausted && out.length && p.mode !== 'mock') {
          jset(lastKey(opt.kind), { fetchedAt: p.fetchedAt, mode: p.mode, picks: out.map(function (o) { return { slot: o.slot, id: o.item.id }; }) });
          setTimeout(function () { cacheArt(out.map(function (o) { return o.item.poster; })); }, 1500);
        }
        cb({ kind: opt.kind || null, mode: p.mode, source: p.source, fetchedAt: p.fetchedAt, weekOf: p.weekOf, omdb: p.omdb, picks: out, background: !!bg, exhausted: exhausted });
      }
      if (MOCK) return deliver(mockPool());
      if (!hasTmdb()) return deliver(fromSnapshot());
      var c = jget('rh.dsc.live', null);
      deliver(c || fromSnapshot());
      if (liveStale(c) || opt.force) refreshLive().then(function (p) { if (p) deliver(p, true); });
    },
    /* Called when picks are actually on screen (Discover open), so painting in the background doesn't burn titles. */
    seen: function (ids) { if (ids && ids.length) markShown(ids); },
    hasLiveKeys: hasTmdb,
    /* per-platform carousel (live keys only): ordered app keys, Top 3 per tab, neighbour prefetch, launch counting */
    platforms: function () { return hasTmdb() && !MOCK && D.platformPages !== false ? platforms() : []; },
    platformPicks: platformPicks,
    prefetchPlatform: prefetchPlatform,
    noteLaunch: noteLaunch,
    _quality: quality,
    trakt: traktAuth,
    continueWatching: continueWatching,
    dismiss: dismiss,                 // 'Not Interested': never shown again (local), nudges genre weights down a little
    selected: selected,               // Open / Trailer from a pick: nudges kind + genre weights up a little
    art: art,                         // cached data: URL for a poster (offline paint), else the URL itself
    prefs: prefs,
    _choose: choose, _score: score, _context: context, _snapshot: fromSnapshot
  };
})();
