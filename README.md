# Glass Home — a calm home screen for Samsung Tizen TVs

A "Liquid Glass"-style launcher web app for Samsung Smart TVs. It shows a big clock, the weather and slowly rotating scenic
photos, with a glass dock of your streaming apps one button-press away. Press **Up** and you get **Discover**: one streaming
service at a time (Netflix, HBO Max, Prime Video, Hulu, Apple TV+, Peacock, Disney+), each with its **Top 3 Shows / Top 3
Movies** ranked by IMDb + Rotten Tomatoes, sliding from service to service like a carousel, plus optional **Resume
Watching** from your Trakt account. Without API keys it falls back to three "Tonight's Picks" from a dated IMDb snapshot.

It is plain HTML/CSS/JavaScript (no framework, no build step besides a small shell script), designed for a 1920×1080 TV.

| Ambient (what you see most of the time) | Dock revealed |
|---|---|
| ![Ambient](docs/preview-v2-ambient.png) | ![Dock](docs/preview-v2-dock.png) |
| **Discover → Movies** | **Discover → Shows** |
| ![Discover movies](docs/preview-v2-discover-movies.png) | ![Discover shows](docs/preview-v2-discover-shows.png) |
| **Discover → Netflix (Movies)** | **Discover → HBO Max (Shows)** |
| ![Netflix page](docs/preview-v3-netflix.png) | ![HBO Max page](docs/preview-v3-hbo.png) |

*(Screenshots are headless desktop renders at 1920×1080.)*

---

## Contents

1. [Honest limits (read first)](#honest-limits-read-first)
2. [Compatibility](#compatibility)
3. [What you need](#what-you-need)
4. [Install, step by step](#install-step-by-step)
   1. [Enable Developer Mode on the TV](#step-1--enable-developer-mode-on-the-tv)
   2. [Install the Tizen Studio CLI + extensions](#step-2--install-the-tizen-studio-cli--extensions)
   3. [Create a Samsung certificate](#step-3--create-a-samsung-certificate)
   4. [Get free API keys (optional)](#step-4--get-free-api-keys-optional)
   5. [Configure](#step-5--configure)
   6. [Build](#step-6--build)
   7. [Package, install and run](#step-7--package-install-and-run)
   8. [Make it open when the TV turns on](#step-8--make-it-open-when-the-tv-turns-on)
5. [Remote controls](#remote-controls)
6. [Trying it on your computer first](#trying-it-on-your-computer-first)
7. [Troubleshooting](#troubleshooting)
8. [Uninstall / undo everything](#uninstall--undo-everything)
9. [Project layout](#project-layout)
10. [Credits & licenses](#credits--licenses)

---

## Honest limits (read first)

- **It sits on top of Samsung's home screen; it does not replace it.** Samsung doesn't let third-party apps become the
  system launcher. The **Home** button on the remote will always open Samsung's own home bar. Step 8 shows how to make
  this app come back automatically when the TV turns on.
- **No cross-app watch history.** Netflix, Prime, etc. don't share what you're watching with other apps. "Resume Watching"
  only works if you use [Trakt](https://trakt.tv) (and something that scrobbles to Trakt); without it that row simply hides.
- **"Open in &lt;App&gt;", not "Play".** Streaming apps don't offer a public way to jump straight to a title, so a pick
  opens the right app and you find the title there. Only YouTube trailers open directly.
- **Developer-mode apps aren't permanent.** Apps sideloaded in Developer Mode can disappear or stop launching after
  firmware updates, factory resets, or when the developer certificate expires. You may need to rebuild, re-sign and
  reinstall from time to time (it takes a minute once everything is set up).
- **Your API keys end up inside your build.** `tools/make-dist.sh` writes your keys (and Trakt tokens) into
  `dist/js/config.js`, which is packaged into the `.wgt`. **Never publish or share your `dist/` folder or `.wgt` file.**
  The repo itself keeps every key field empty, and `.gitignore` excludes `dist/`, `.secrets/` and `*.wgt`.
- Tonight's Picks are deliberately "light": comedy-led, family/romance OK, no horror/thriller/crime/war leads.
  Change the filters in `js/discover.js` if you want something else.
- Weather is in °F (Open-Meteo). App IDs and streaming-service matching are tuned for the **US** region.

## Compatibility

| | |
|---|---|
| Suggested | Samsung Smart TVs with **Tizen 6.0 or newer** (roughly **2021 models and later**). `config.xml` sets `required_version="6.0"`. |
| Tested on | **Samsung QN90A (2021, Tizen 6.0)**, US region |
| Older TVs | Might work, untested. The code avoids newer JS/CSS (Tizen 6.0 is a Chromium-76-class browser). |
| Not supported | Non-Samsung TVs, Samsung TVs not running Tizen. |

## What you need

- A Samsung Tizen TV (see above) connected to your home network.
- A **Mac or Windows PC on the same Wi-Fi/network** as the TV. (Linux works too; commands are the same as Mac.)
- A free **Samsung account** (used to create the signing certificate).
- About 30–45 minutes the first time.
- Optional, all free: a TMDB account, an OMDb key, a Trakt account.

---

## Install, step by step

> Throughout this guide, replace `<TV_IP>` with your TV's IP address and `<TARGET>` with the device name that
> `sdb devices` prints (it usually looks like `<TV_IP>:26101` or your model number, e.g. `QN75QN90AAFXZA`).

### Step 1 — Enable Developer Mode on the TV

1. Find your **computer's** IP address:
   - Mac: System Settings → Wi-Fi → Details → IP address (or run `ipconfig getifaddr en0`).
   - Windows: run `ipconfig` in Command Prompt and look for "IPv4 Address".
2. On the TV, open the **Apps** panel (Home button → Apps).
3. With the Apps screen open, type **`1` `2` `3` `4` `5`** on the remote (on remotes without number keys use the
   on-screen number pad: press the 123/color button). A *Developer Mode* dialog appears.
4. Switch **Developer mode** to **On**, enter your computer's IP in **Host PC IP**, and press **OK**.
5. **Restart the TV**: hold the power button on the remote until the TV turns off and back on (a normal off/on is not
   enough). Afterwards the Apps screen shows "Developer Mode" at the top.
6. Find the **TV's IP address**: Settings → General → Network → Network Status → IP Settings.

### Step 2 — Install the Tizen Studio CLI + extensions

1. Download **Tizen Studio "CLI" installer** (the small one, not the full IDE) from
   <https://developer.tizen.org/development/tizen-studio/download> (scroll to *Installing Tizen Studio CLI*).
   You also need Java (a JDK/JRE 8 or newer) for the package manager.
2. Install it:

   **Mac**
   ```sh
   cd ~/Downloads
   chmod +x web-cli_Tizen_Studio_*_macos-64.bin
   ./web-cli_Tizen_Studio_*_macos-64.bin --accept-license ~/tizen-studio
   echo 'export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   ```

   **Windows** (Command Prompt): run `web-cli_Tizen_Studio_<version>_windows-64.exe`, install to `C:\tizen-studio`, then
   add the tools to your PATH:
   ```bat
   setx PATH "%PATH%;C:\tizen-studio\tools;C:\tizen-studio\tools\ide\bin"
   ```
   Close and reopen Command Prompt afterwards.

3. Install the TV extensions and the certificate tools with the Package Manager:

   **Mac**
   ```sh
   ~/tizen-studio/package-manager/package-manager-cli.bin install --accept-license \
     cert-add-on TV-SAMSUNG-Extension-Tools Certificate-Manager
   ```
   **Windows**
   ```bat
   C:\tizen-studio\package-manager\package-manager-cli.exe install --accept-license cert-add-on TV-SAMSUNG-Extension-Tools Certificate-Manager
   ```
   - `cert-add-on` = **Samsung Certificate Extension** (lets you create *Samsung*-type certificates).
   - `TV-SAMSUNG-Extension-Tools` = Samsung TV tools/profile.
   - `Certificate-Manager` = the **Certificate Manager** app.

   Package names occasionally change between Tizen Studio versions. If one is "not found", list them with
   `package-manager-cli.bin show-pkgs` (Windows: `package-manager-cli.exe show-pkgs`), or open the graphical Package
   Manager (`~/tizen-studio/package-manager/package-manager.bin` / `C:\tizen-studio\package-manager\package-manager.exe`),
   go to **Extension SDK** and install **TV Extensions** and **Samsung Certificate Extension**.

4. Check it works:
   ```sh
   tizen version
   sdb version
   ```

### Step 3 — Create a Samsung certificate

The TV only installs apps signed with a Samsung certificate that names your TV's **DUID** (a unique device ID).

1. Connect to the TV once (so the Certificate Manager can read the DUID):
   ```sh
   sdb connect <TV_IP>
   sdb devices          # should list your TV; note the name in the first column = <TARGET>
   ```
2. Open **Certificate Manager**:
   - Mac: `~/tizen-studio/tools/certificate-manager/` → open the Certificate Manager app.
   - Windows: `C:\tizen-studio\tools\certificate-manager\certificate-manager.exe`.
3. Click **+** (create a certificate profile) → choose **Samsung** → device type **TV** → give the profile a name
   (any name, e.g. `MyTV`; this is your `<CERT_PROFILE>`).
4. **Author certificate**: *Create a new author certificate*, fill in a name and a password, sign in with your Samsung
   account when asked.
5. **Distributor certificate**: keep the default privilege (**Public**). In the **DUID** list your TV should appear
   automatically. If it doesn't, get the DUID yourself and paste it in:
   ```sh
   sdb shell 0 getduid
   ```
6. Finish. Make sure the new profile is the **active** one (check mark) in Certificate Manager.

> The certificate is tied to **your** TV's DUID. If you get a different TV, add its DUID to the profile and re-sign.

### Step 4 — Get free API keys (optional)

Everything is optional. **With no keys** the launcher still works: Tonight's Picks come from the bundled, dated
snapshot of IMDb's public "Most Popular" charts (`data/weekly.embed.js`) and Resume Watching is hidden.

| Service | What it adds | Where | Env var |
|---|---|---|---|
| **TMDB** | Live trending picks, where-to-watch (US), runtimes, trailers | <https://www.themoviedb.org/settings/api> (free account → request an API key; "Developer", personal use) | `TMDB_API_KEY` (v3 key) **or** `TMDB_READ_TOKEN` (v4 read token) |
| **OMDb** | IMDb ratings on the picks (free tier: 1,000 requests/day) | <https://www.omdbapi.com/apikey.aspx> (choose FREE, confirm the email) | `OMDB_API_KEY` |
| **Trakt** | Resume Watching, hide already-watched titles, recommendations | <https://trakt.tv/oauth/applications> → **New Application** | `TRAKT_CLIENT_ID` (and optionally `TRAKT_CLIENT_SECRET`) |

**Trakt setup (optional):**
1. Create the app with **Redirect URI** `http://localhost` and tick the **PKCE** option if offered (no secret needed).
2. Copy the **Client ID**.
3. Link your account once from your computer (needs only `sh`, `curl`, `openssl`; on Windows use Git Bash or WSL):
   ```sh
   TRAKT_CLIENT_ID=your_client_id sh tools/trakt-link.sh
   ```
   It prints (and on a Mac opens) a Trakt sign-in URL. Approve; the browser then lands on
   `http://localhost/?code=...` and shows an error page — **that's expected**. Copy the whole address-bar URL and paste it
   into the script. Tokens are saved to `.secrets/trakt-tokens.json` (never printed, git-ignored) and baked into your
   build by step 6. The TV refreshes them on its own afterwards.

   (There is also an on-TV "Link" option using Trakt's device code flow, but it needs a client secret; the script above
   is the reliable path.)

### Step 5 — Configure

All settings live in two files. Edit them before building.

**a) Your apps — `js/apps.js` and the dock list in `js/config.js`**

`js/apps.js` already knows YouTube, Netflix, HBO Max, Prime Video, Hulu, Apple TV, Peacock and Disney+.
Choose which appear (and in what order) in `js/config.js`:
```js
dock: {
  main:  ['youtube', 'netflix', 'hbomax', 'prime', 'hulu', 'appletv'],   // large icons
  extra: ['peacock', 'disney']                                           // smaller icons after a divider
},
```
You don't need to have every app installed; the launcher tries several known IDs and also matches installed apps by name.

*Adding an app or fixing an ID.* Launching needs the app's **Tizen app ID** (looks like `9Ur5IzDKqV.TizenYouTube`).
Ways to find the IDs on your TV:
- Set `debug: true` in `js/config.js`, build and install, then open the Web Inspector
  (`tizen run -p GlassHome1.launcher -t <TARGET>` while Developer Mode is on, or use `sdb shell 0 debug GlassHome1.launcher`
  and open the printed port in Chrome). The console logs an `installed map` of every app name → ID.
- Or try `sdb shell 0 vd_applist` (works on many Samsung firmwares) and look for the app's name.
- Community lists: [homebridge-samsung-tizen app IDs](https://github.com/tavicu/homebridge-samsung-tizen) and
  [samsung-tv-ws-api APPLICATIONS.md](https://github.com/xchwarze/samsung-tv-ws-api).

Then either put the ID first in that app's `tizenIds` in `js/apps.js`, or override it without touching apps.js:
```js
appIdOverrides: { peacock: ['gzcc4LRFBF.Peacock'] },
```
To add a new app, copy one entry in `js/apps.js` (give it a key, `name`, `color`, `tizenIds`, `names`, `match`) and add the
key to `dock.main` or `dock.extra`. Icons/logos are in `js/logos.js`.

**b) Weather location — `js/config.js` → `weather`**
```js
weather: {
  enabled: true,
  lat: 37.3382, lon: -121.8863,   // example: San Jose, CA  ← CHANGE to your location
  timezone: 'America/Los_Angeles', // ← your IANA time zone, e.g. 'America/New_York', 'Europe/London'
  ...
}
```
Look up your coordinates on any map (right-click → coordinates). Weather comes from Open-Meteo (free, no key).
Set `enabled: false` to hide it.

**c) Greeting / household name — `js/config.js` → `ui`**
```js
ui: { greeting: true, userName: 'Smith family', clock24h: false, ... }
```
`userName: ''` shows just "Good evening". `greeting: false` hides it.

**d) Other useful settings** (all in `js/config.js`, each commented): `discover.region` (TMDB watch region, default `US`),
`wallpaper.intervalSec` (default 50 s), `idle.minutes` (fade to wallpaper-only after 10 min), `idle.keepScreenOn`,
`back.mode` (`'double'` = press Back twice on the first tile to exit, `'never'`).

**e) Optional: change the app's ID/name.** `config.xml` uses package `GlassHome1` / app ID `GlassHome1.launcher` and the
name **Home**. If you change the ID, the package part must be exactly 10 letters/digits, and use your new ID in the
commands below.

### Step 6 — Build

`tools/make-dist.sh` copies only the runtime files into `dist/`, inlines the CSS, and injects your keys from environment
variables into `dist/js/config.js` (only there — the repo copy stays empty). It prints which keys it used, never their values.

**Mac / Linux**
```sh
cd path/to/this/repo
export TMDB_API_KEY=xxxxxxxx      # or: export TMDB_READ_TOKEN=xxxxxxxx
export OMDB_API_KEY=xxxxxxxx
export TRAKT_CLIENT_ID=xxxxxxxx   # optional; tokens from tools/trakt-link.sh are picked up automatically
sh tools/make-dist.sh
```
**Windows**: run the same in **Git Bash** (comes with [Git for Windows](https://git-scm.com/download/win)) or WSL; it needs
`sh` and `python3`.
```sh
TMDB_API_KEY=xxxx OMDB_API_KEY=xxxx sh tools/make-dist.sh
```
No keys? Just run `sh tools/make-dist.sh` — it builds in offline snapshot mode.

Supported variables: `TMDB_API_KEY`, `TMDB_READ_TOKEN`, `OMDB_API_KEY`, `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`.

### Step 7 — Package, install and run

```sh
# 1. Sign and package dist/ into a .wgt with your certificate profile from step 3
tizen package -t wgt -s <CERT_PROFILE> -- dist
ls dist/*.wgt            # the file is named after <name> in config.xml: dist/Home.wgt

# 2. Connect and install in ONE command (the TV tends to drop idle sdb connections)
sdb connect <TV_IP> && tizen install -n Home.wgt -t <TARGET> -- dist

# 3. Start it
tizen run -p GlassHome1.launcher -t <TARGET>
```
On Windows Command Prompt the same commands work (`&&` is supported in cmd).

Tips:
- `<TARGET>` is the name shown by `sdb devices` (first column).
- If `sdb` acts up ("target not found", "device offline"), reset it and reconnect:
  ```sh
  sdb kill-server
  sdb connect <TV_IP>
  sdb devices
  ```
- After changing settings, repeat steps 6 and 7. Re-installing replaces the old version.

The app also appears in the TV's **Apps** list as **Home** (you can add it to the Home bar from there).

### Step 8 — Make it open when the TV turns on

Samsung TVs can reopen the last app you used on power-on:

**Settings → General → Start Screen Option** (on some models **Smart Features**) → **Autorun Last App: On**.

Leave the launcher in front when you turn the TV off, and it comes back next time. (The Home button will still open
Samsung's home bar — see [Honest limits](#honest-limits-read-first).)

---

## Remote controls

| Button | What it does |
|---|---|
| Any arrow / **Enter** (in Ambient) | Reveal the dock (that first press does nothing else) |
| **Left / Right** | Move between apps, cards, tabs |
| **Enter** | Launch the focused app / run the focused action |
| **Up** (from the dock) — "Up for picks" | Open **Discover** (Resume Watching first if you have any, otherwise the middle pick; Movies \| Shows tabs) |
| **Up / Down** (in Discover) | Move between Resume Watching, the service header, Movies \| Shows tabs, picks and the card actions (*Open in &lt;App&gt;*, *Trailer*, *Not interested*) |
| **Left / Right** on the service header | Slide to the previous / next streaming service (also: Right past the last card, Left past the first) |
| **Channel Up / Down** (in Discover) | Next / previous streaming service from anywhere in Discover |
| **Down** from a pick | Its actions; **Down** again (from the actions) returns to the dock |
| **Back** | Step back: hide the photo credit → leave a card's actions → leave Discover → hide the dock → jump to the first tile. From there, Back **twice within 2 s** exits (`back.mode`; `'never'` disables exiting) |
| **Red** | Cycle the glass look: baked → live blur → solid |
| **Green** | Show/hide an FPS counter |
| **Yellow** | On a focused pick: *Not interested* (never shows again). Elsewhere: show the wallpaper photo credit |
| **Blue** | Next wallpaper |
| Any key while idle | Wakes the screen (that key does nothing else) |

The dock hides again after 8 s without a key (`dockAutoHideSec`). After 10 min idle everything fades out except the
wallpaper, which slowly dims (`idle` settings).

## Trying it on your computer first

Open `index.html` in Chrome (double-click it). Keyboard: arrows, Enter, Esc/Backspace = Back, and for the colour keys
`R` = Red, `F` = Green (FPS), `I` = Yellow, `N` = Blue, `P` = new picks. Useful URL options: `?mock=1` (clearly labelled
fake data), `?blur=baked|live|off`, `?discover=0`, `?wp=off`, `?idle=0`, `?dock=1`, `?tab=movie|tv`, `?plat=netflix|hbomax|prime|hulu|appletv|peacock|disney`.

Developer scripts in `tools/` (`test-nav.js`, `preview-v2.js`, `preview-v3.js`, `screenshot.js`, `fetch-weekly.js`, …) need Node.js,
`npm install playwright-core` and Google Chrome (set `CHROME=/path/to/chrome` if it's not at `/usr/bin/google-chrome`).
`node tools/fetch-weekly.js` refreshes the offline IMDb snapshot (picks older than 21 days are hidden).

## Troubleshooting

| Problem | Fix |
|---|---|
| **`sdb devices` is empty / "target not found" / "device offline"** | TV and computer on the same network? Developer Mode **On** with **your computer's current IP** as Host PC IP (your IP may have changed — re-enter it and restart the TV)? Then `sdb kill-server`, `sdb connect <TV_IP>`, `sdb devices`. Firewalls/VPNs can block port 26101. Use the connect-and-install one-liner from step 7. |
| **"Problem to transfer package" / install fails** | Usually a dropped connection: run `sdb kill-server`, then `sdb connect <TV_IP> && tizen install -n Home.wgt -t <TARGET> -- dist`. Also check the TV has free storage, and that `dist/Home.wgt` exists (re-run `tizen package`). |
| **Install fails with a certificate / signature / "DUID" error** | The certificate doesn't include this TV's DUID, or the wrong profile was used. Run `sdb shell 0 getduid`, add that DUID to your distributor certificate in Certificate Manager (or create a new Samsung TV profile), make it active, then `tizen package -t wgt -s <CERT_PROFILE> -- dist` again. Also make sure you created a **Samsung** (not *Tizen*) certificate. |
| **Launcher installed, but an app tile does nothing / "couldn't open"** | Wrong app ID for your TV/region, or the app isn't installed. Find the real ID (step 5a) and add it to `appIdOverrides` or the top of `tizenIds`. |
| **The launcher itself won't start or disappeared** | Developer-mode apps can be removed by firmware updates or an expired certificate. Re-enable Developer Mode if it got switched off, re-create/renew the certificate if needed, and repeat steps 6–7. |
| **No weather** | Check `weather.lat/lon` and internet access. The block hides itself rather than showing fake numbers. |
| **Picks say "IMDb Most Popular snapshot"** | No TMDB key in the build (or TMDB unreachable). Add `TMDB_API_KEY` and rebuild. Snapshot picks hide after 21 days; refresh with `node tools/fetch-weekly.js`. |
| **No Resume Watching** | Needs Trakt (`TRAKT_CLIENT_ID` + `tools/trakt-link.sh`) and real unfinished content in your Trakt history. |
| **Debugging** | Set `debug: true` in `js/config.js`, rebuild, and use `sdb shell 0 debug GlassHome1.launcher` to get a Web Inspector port. |

## Uninstall / undo everything

```sh
sdb connect <TV_IP>
tizen uninstall -p GlassHome1.launcher -t <TARGET>
```
(Or on the TV: Apps → Settings (gear) → select **Home** → Delete.)

Then, to put the TV back to normal:
- Turn **Developer Mode off**: Apps panel → type `1 2 3 4 5` → Developer mode **Off** → restart the TV (hold power).
- Optionally turn **Autorun Last App** back off.
- On your computer: delete `dist/`, `.secrets/` and any `.wgt`; revoke the Trakt app at <https://trakt.tv/oauth/authorized_applications>
  and remove the Tizen Studio folder if you no longer need it.

## Discover by streaming service

Needs a free TMDB key (OMDb recommended). Discover shows **one service per page**, in dock order, re-sorted by how often
you open each app from Glass Home (`discover.platforms`, `platformsByUsage`; YouTube has no catalogue and is skipped).

- **Top 3 Shows / Top 3 Movies** (one row; the Movies | Shows tab switches). Candidates come from TMDB `discover` limited
  to that service's US **subscription** catalogue (`with_watch_providers` + `watch_region=US` + `flatrate`), comedy-led
  with a broader well-voted query; no animation/anime, crime, horror, thriller, war, reality, talk or news leads.
  Titles you marked *Not interested* or already watched on Trakt never appear.
- **Ranking:** IMDb rating via OMDb (with a vote-count sanity check) blended with the **Rotten Tomatoes** critics score
  (OMDb `Ratings`), then popularity, a light-comedy bonus and what you tend to open. TMDB's own score only stands in when
  OMDb has nothing.
- **Tiles:** pre-blurred "liquid glass" (no live blur), poster, title, year · runtime (or seasons), genre, an `IMDb 8.1`
  badge and a tomato `92%` badge, the latter **only** when OMDb has a real RT score (TV series often don't). Actions appear
  only on the focused card.
- **Carousel:** Left/Right on the service header (or Channel Up/Down) slides the page out and the next one in, using only
  `transform` + `opacity` (300 ms; instant with reduced motion). Rapid presses never queue.
- **Caching:** each service's list is stored in `localStorage` (`rh.dsc.plat.<service>`, refreshed after 12 h in the
  background) and the neighbouring services are prefetched, so paging is instant. No key or no network and no cache →
  the classic three Tonight's Picks from the snapshot.
- **No "coming soon / leaving soon" rows:** there's no free, keyless, reliable source for them (TMDB has none, JustWatch has
  no public API, Watchmode's free tier needs its own key and only previews 10 leaving titles), so they're not shown rather
  than guessed.

## Project layout

| Path | Purpose |
|---|---|
| `config.xml` | Tizen widget manifest (app ID, privileges, `required_version` 6.0, profile `tv-samsung`) |
| `index.html`, `icon.png`, `css/style.css` | Entry point, icon, styles (CSS is inlined into `dist/index.html` by the build) |
| `js/config.js` | **All user settings** + empty key placeholders |
| `js/apps.js`, `js/logos.js` | App catalogue (Tizen IDs, name matching) and dock logos |
| `js/app.js` | Focus engine, Ambient/Discover, launching, remote keys, clock, idle |
| `js/discover.js` | Per-service Top 3 (TMDB discover + OMDb IMDb/Rotten Tomatoes), Tonight's Picks fallback (IMDb snapshot), scoring, Trakt |
| `js/weather.js` | Open-Meteo weather |
| `js/wallpaper.js`, `js/wallpapers.js` | Wallpaper rotator + "baked glass", wallpaper list/credits |
| `js/tizen-shim.js` | Lets the app run in a desktop browser for previews |
| `data/weekly.json`, `data/weekly.embed.js` | Dated snapshot of IMDb's public Most Popular charts (offline picks) |
| `images/wallpapers/` | 10 bundled 4K (3840×2160) photos (+ `blur/` pre-blurred copies) — see `CREDITS.md` |
| `tools/make-dist.sh` | Build `dist/`, inject keys from env vars |
| `tools/trakt-link.sh` | One-time Trakt sign-in (PKCE) |
| `tools/build-wallpapers.py`, `tools/wallpapers.json` | Rebuild wallpapers from Wikimedia Commons |
| `tools/fetch-weekly.js` | Refresh the IMDb snapshot |
| `tools/test-*.js`, `tools/preview-v2.js`, `tools/preview-v3.js`, `tools/screenshot.js` | Headless tests and screenshots (Playwright + Chrome) |
| `docs/` | README screenshots |

## Credits & licenses

- **Code:** MIT — see [`LICENSE`](LICENSE). © 2026 Rudraksh Syal.
- **Wallpapers:** 10 photos (3840×2160, cropped from larger originals) from Wikimedia Commons under CC0, CC BY 2.0, CC BY-SA 2.0/3.0/4.0 or public domain (US NPS).
  Photographers, licenses and source links are in [`CREDITS.md`](CREDITS.md); the credit is also viewable on screen
  (Yellow key). The resized copies of BY-SA photos are shared under the same license as the originals. These photos are
  **not** MIT-licensed.
- **Data:** [TMDB](https://www.themoviedb.org) (this product uses the TMDB API but is not endorsed or certified by TMDB),
  [OMDb](https://www.omdbapi.com), [Trakt](https://trakt.tv), [Open-Meteo](https://open-meteo.com) (CC BY 4.0).
  The offline snapshot in `data/` is taken from IMDb's public charts (titles, ratings, poster URLs) for personal,
  non-commercial use.
- **App IDs:** community research from [homebridge-samsung-tizen](https://github.com/tavicu/homebridge-samsung-tizen) and
  [samsung-tv-ws-api](https://github.com/xchwarze/samsung-tv-ws-api).
- Samsung, Tizen, Netflix, YouTube, HBO Max, Prime Video, Hulu, Apple TV, Peacock and Disney+ are trademarks of their
  owners. This project is not affiliated with any of them. App logos in `js/logos.js` are used only to identify the apps.
