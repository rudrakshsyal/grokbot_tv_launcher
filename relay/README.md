# Glass Home relay (v6.2)

A small Node server that runs on a Mac on your home network (any always-on computer with Node works; the examples call its address `YOUR-MAC-IP`). It has **no npm dependencies**.
- Your **iPhone** is a TV remote and the microphone. The phone page (add it to the Home Screen) has three tabs: **Remote** (D-pad, Back, Home, Play/Pause, volume, power, app shortcuts), **Yo-Yo** (a chat: hold the mic and speak, or type; answers can be spoken) and **Home** (smart-home placeholder).
- The relay works out the answer and streams each step to the **TV** over Server-Sent Events (`GET /events`).
- The TV shows the "Orb + Timeline" overlay. When the relay can't be reached, the TV feature stays hidden.

Requirement: **Node.js 14 or newer on the Mac.** Run `node -v`; if Node is missing, install it from https://nodejs.org or with `brew install node`.

## Run it

```sh
cd relay
cp .env.example .env && chmod 600 .env     # then fill in your own values (never commit .env)
set -a && . ./.env && set +a && node server.js
# or inline: TV_IP=192.168.1.50 TMDB_API_KEY=… OMDB_API_KEY=… GEMINI_API_KEY=… node server.js
```

The startup output lists the brain chain, which keys are present and the phone URL. Then:

- **iPhone**: in Safari, open `http://YOUR-MAC-IP:8787/` (or `https://YOUR-MAC-IP:8788/` once certificates are set up, see *HTTPS*). Tap Share → **Add to Home Screen** (re-add it if you had the old icon), and allow the microphone when asked.
  - **Yo-Yo tab: press and hold** the mic while you talk, release to send. Slide your finger off the button to cancel.
    On the HTTPS page the phone records with `MediaRecorder` and the relay transcribes it (`POST /stt`, see *Speech-to-text*),
    so every press works, not only the first. On plain http it falls back to Safari's speech recognition.
    If a press hears nothing it says "Didn't catch that, hold and try again".
  - **Speak answers** is on by default: the phone reads a short version of each answer (the first 2 sentences) in the
    iPhone's own voice, which is free. Holding the mic stops the voice. Tap the speaker icon in the answer to hear it again.
  - **English / हिन्दी / Hinglish** sets the recognition language, the reply language and the voice
    (Samantha or Ava; Lekha for Hindi; Rishi or Veena for en-IN). Better voices: iPhone Settings › Accessibility ›
    Spoken Content › Voices › download an *Enhanced* or *Premium* voice.
  - **Chats** (v6): every conversation is saved on the Mac; ☰ lists them (open, rename, delete), **+** starts a new one. See *Chats*.
- **TV**: the launcher connects to `config.voice.relay` (`http://YOUR-MAC-IP:8787` in `js/config.js`).
  - Press **Play/Pause** on the remote to open the overlay.
  - The overlay also opens by itself when you ask from the phone.
  - ◀ ▶ ▲ ▼ choose a title, **OK** opens its app, **Back** closes.

The Mac and the TV must be on the same Wi-Fi. The first time you run it, macOS may ask whether to allow incoming connections for `node`; click Allow.

Other modes:
- `MOCK=1 node server.js` replays a recorded real session (`mock-session.json`). It needs no keys or network, which makes it handy for checking the TV side.
- `BRAIN=free node server.js` uses only the built-in rule-based parser. It's completely free, needs no LLM key, and still uses TMDB, OMDb and the weather service.

## Brains: primary LLM → Ollama (if running) → built-in parser

| `BRAIN_PRESET` | Endpoint (OpenAI-compatible) | Default model | Key |
|---|---|---|---|
| `gemini` (default) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-3.8-flash` | `GEMINI_API_KEY` |
| `groq` | `https://api.groq.com/openai/v1/` | `openai/gpt-oss-120b` | `GROQ_API_KEY` |
| `ollama` | `http://localhost:11434/v1/` | `qwen3:8b` | none |

How the brains are tried:
- If the primary returns 429, 5xx, 401/403 or times out, the relay tries the next brain.
- **Ollama** is used as the next brain only when it's running and the model has been pulled. The relay checks `/api/tags` with a 400 ms timeout.
- The built-in parser is the last fallback.
- With no key and no Ollama, every request goes straight to the parser.

Other settings:
- Any other provider works with `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. These override the preset.
- Each phone gets its own conversation memory: the last 8 questions, reset after 30 minutes idle (or with **New chat**).
  Only the last 2 turns keep their tool calls and results. Older turns are kept as plain question/answer text to save tokens.
  If the model rejects a request that includes history, the relay retries once with plain-text memory before falling back to the parser.
- Requests that the parser doesn't understand get: "I can help with shows, movies, ratings, weather and opening apps".

### Get a free key (no credit card)

**Gemini**
1. Go to https://aistudio.google.com and sign in with a Google account.
2. Click **Get API key** → **Create API key**.
3. Run with `GEMINI_API_KEY=…`.

Free-tier limits are set per project and shown in AI Studio. Requests per day reset at midnight Pacific. On the free tier, Google may use your prompts to improve its products. See https://ai.google.dev/gemini-api/docs/pricing and https://ai.google.dev/gemini-api/docs/rate-limits.

**Groq**
1. Go to https://console.groq.com and sign in.
2. Open **API Keys** → **Create API Key**.
3. Run with `BRAIN_PRESET=groq GROQ_API_KEY=…`.

Free limits for gpt-oss-120b: 30 requests/min, 1,000 requests/day, 8K tokens/min, 200K tokens/day. Groq doesn't train on your data. See https://console.groq.com/docs/rate-limits.

### Ollama (local, free, private)

1. Install it with `brew install ollama` or the app from https://ollama.com/download.
2. Start it by opening the Ollama app, or run `ollama serve`.
3. Pull a model: `ollama pull qwen3:8b`. It's 5.2 GB and supports tool calling. On an 8 GB MacBook Air, use `ollama pull qwen3:4b` and run with `OLLAMA_MODEL=qwen3:4b`.
4. Run with `BRAIN_PRESET=ollama node server.js`. Or use any other preset: Ollama is picked up automatically as the fallback.

Other tool-capable models are listed at https://ollama.com/search?c=tools. Local answers are slower than the cloud models on a MacBook Air.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `TMDB_API_KEY` / `TMDB_READ_TOKEN` | – | TMDB titles, providers and posters (needed for title searches) |
| `OMDB_API_KEY` | – | IMDb and Rotten Tomatoes scores |
| `BRAIN` | `auto` | `free` = parser only |
| `BRAIN_PRESET` | `gemini` | `gemini`, `groq` or `ollama` |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | – | Preset keys |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | preset | Any OpenAI-compatible endpoint or model |
| `LLM_FALLBACK_MODEL` / `_BASE_URL` / `_API_KEY` | – | Optional second cloud model, tried before Ollama |
| `LLM_REASONING` | `low` (cloud) | `reasoning_effort`; leave empty to omit it |
| `LLM_MEMORY_MS` | `1800000` | Conversation idle reset (30 min) |
| `LLM_MEMORY_TURNS` | `8` | Questions remembered per phone |
| `LLM_MAX_TOKENS`, `LLM_TEMPERATURE` | `1024`, – | Model call settings |
| `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_FALLBACK` | `http://localhost:11434`, `qwen3:8b`, on | Set `OLLAMA_FALLBACK=0` to skip Ollama |
| `WEATHER_LAT`, `WEATHER_LON`, `WEATHER_PLACE` | San Jose (example) | Open-Meteo forecast (°F) |
| `HOME_TZ` | `America/Los_Angeles` | Time zone for "today" and the date in the prompt |
| `CHATS_DIR`, `DATA_DIR` | `relay/data/chats`, `relay/data` | Saved chats / learned TV info (git-ignored) |
| `MOCK` | – | `1` = replay `mock-session.json` |
| `LOG` | on | `0` = quiet |

## Phone remote (Samsung TV)

The relay talks to the TV with Samsung's local remote API (the same one the SmartThings app uses): a WebSocket on
`wss://TV_IP:8002/api/v2/channels/samsung.remote.control` for keys, and `http://TV_IP:8001/api/v2/applications/<appId>`
for launching apps (WebSocket `ed.apps.launch` as a fallback). Nothing is installed on the TV.
The handshake matches samsungtvws: `?name=<base64 of "Glass Home Remote">` (`R2xhc3MgSG9tZSBSZW1vdGU=`), plus `&token=…` once paired. TVs whose
`GET :8001/api/v2/` reports `TokenAuthSupport: "false"` (pre-2018) use plain `ws://TV_IP:8001` instead; 2021 models like the
QN90A report `true` and use `wss://…:8002`. The relay picks this from `/api/v2/` automatically (`TV_WS_MODE` overrides it).

Pairing, once:
0. On the TV: Settings → General → External Device Manager → **Device Connection Manager** → **Access Notification** → **First Time Only**.
1. Turn the TV on. Run the relay and open the phone page.
2. Tap **Pair** on the banner, or press any button on the **Remote** tab. The phone shows **"Look at your TV and choose Allow"** and the TV shows
   **"Glass Home Remote" wants to connect: Allow / Deny**. Choose **Allow** with the TV remote.
3. The TV sends back a token. It's saved to `relay/.secrets/tv-token.json` (mode 600, gitignored) and reused, so you won't be asked again.

Pairing is attempted **once**. Button presses don't start new attempts after that; use **Retry pair** on the banner (`POST /remote/pair`).
- **Timed out / no prompt on the TV** (the TV sends `ms.channel.timeOut` after ~10–15 s): check that Access Notification is *First Time Only*,
  that the Mac and TV are on the same network and subnet (not a guest network, and no AP/client isolation or separate VLAN), and that the TV is fully on. Then Retry pair.
- **Blocked** ("TV blocked Glass Home Remote"): on the TV go to Settings → General → External Device Manager → Device Connection Manager → **Device List**,
  remove or allow "Glass Home Remote", then Retry pair.

While the TV is off or unreachable, key presses fail right away (with backoff), and the log only records state changes.

### Auto-open the launcher when the TV turns on

Every 5 s the relay polls `GET http://TV_IP:8001/api/v2/` (1.5 s timeout, errors are silent). The TV counts as **on** when it answers and
`device.PowerState` is `on`. It counts as **off** when PowerState is anything else (e.g. `standby`), or after 3 failed polls in a row, so one Wi-Fi blip doesn't look like a power cycle.
On an **off → on** transition (and once when the relay starts, if the TV is already on), the relay:
1. waits 4 s for the TV to settle (no wait at relay start);
2. checks `GET /api/v2/applications/GlassHome1.launcher`, and skips if `running` is true;
3. calls `POST /api/v2/applications/GlassHome1.launcher`. This needs no pairing. It uses WebSocket `ed.apps.launch` only if the remote is paired and REST fails.

It never relaunches while the TV stays on, so if you switch to Netflix, it stays there. Turn it off with `AUTO_LAUNCH=0`. `TV_POLL=0` turns off the power watch entirely.
`/remote/status` shows `power`, `model` and `lastLaunch`.

Power on: Samsung TVs drop the WebSocket in standby, so power-on uses **Wake-on-LAN**. Set `TV_MAC` (TV Settings → Support → About This TV → the Wi-Fi/Ethernet
MAC; or let the relay learn it, see *Wake-on-LAN*) and turn on TV Settings → General → Network → Expert Settings → **Power On with Mobile**.
When the TV is reachable, the power button sends `KEY_POWER` (off). Otherwise it sends the magic packet.

App shortcuts come from the launcher's dock (`js/config.js` + `js/apps.js`). If those files aren't next to the relay, the relay uses `dock-apps.json`;
`node dock-apps.js --write` regenerates that file. **Home** launches `GlassHome1.launcher`. **Yo-Yo on TV** sends an SSE
`{type:'remote', action:'yoyo'}` to the launcher (handled in `js/voice.js`; actions `yoyo`, `stats`, `close`).

| Variable | Default | Meaning |
|---|---|---|
| `TV_IP` | – | TV address (set it; give the TV a DHCP reservation) |
| `TV_MAC` | learned | TV MAC for Wake-on-LAN (`aa:bb:cc:dd:ee:ff`); else learned from the TV (`data/tv.json`) |
| `TV_WOL_ADDR` | – | Extra target for the magic packet (e.g. `192.168.1.255`) |
| `TV_WOL_ADDRS` | – | Comma list that replaces all targets |
| `WOL_PORTS`, `WOL_REPEATS`, `WOL_WATCH_MS` | `9,7`, `3`, `45000` | Magic-packet ports, rounds, and fast power polling after a wake |
| `TV_REMOTE_NAME` | `Glass Home Remote` | Name shown in the TV's Allow prompt and device list |
| `TV_TOKEN_FILE` | `relay/.secrets/tv-token.json` | Where the pairing token is kept |
| `TV_AUTOCONNECT` | on | `0` = don't connect the paired remote when the TV turns on (connects on first button press) |
| `TV_WS_PORT`, `TV_REST_PORT` | `8002`, `8001` | TV API ports |
| `TV_WS_MODE` | `auto` | `auto` = `wss://:8002` unless the TV reports `TokenAuthSupport: false`; `wss` or `ws` to force |
| `TV_PLAIN_WS_PORT` | `8001` | Port for plain `ws://` (old TVs) |
| `AUTO_LAUNCH` | on | `0` = don't open the launcher when the TV turns on |
| `AUTO_LAUNCH_DELAY_MS` | `4000` | Wait after power-on before checking/launching |
| `LAUNCHER_APP_ID` | `GlassHome1.launcher` | App opened on power-on |
| `TV_POLL_MS` | `5000` | Power poll interval |
| `TV_POLL` | on | `0` = no power watch (then `TV_AUTOCONNECT` connects at startup) |

Undo / unpair: delete `relay/.secrets/tv-token.json` and remove the remote (`TV_REMOTE_NAME`) in Device Connection Manager.

Icons: `python3 tools/make-remote-icon.py` (from the launcher root, needs Pillow) regenerates `relay/icons/icon-{180,192,512}.png`.

## Endpoints

| Method and path | What it does |
|---|---|
| `GET /` | Phone page |
| `GET /events` | SSE stream for the TV |
| `GET /status` | Status (JSON) |
| `GET /last` | Last answer |
| `POST /ask {text, client?, lang?, chatId?, newChat?}` | Waits for the answer. `lang` is `en-US`, `hi-IN` or `en-IN`. The answer includes `spoken`, a short TTS version. A newer question from the same phone replaces the old one, which returns `superseded` |
| `POST /chat/reset {client}` | Legacy (v5 phones): forget this phone's conversation |
| `GET /chats`, `POST /chats` | List chats (newest first, title + preview) / create one |
| `GET /chats/:id` | One chat with its messages |
| `POST /chats/:id/rename {title}`, `POST /chats/:id/delete` | Rename / delete |
| `GET /stt`, `POST /stt?lang=&sec=` | Speech-to-text status / transcribe a raw recording (`Content-Type: audio/mp4`, webm, ogg, wav). 413 too long, 422 no speech, 429 slow down or daily cap, 503 off |
| `GET /ca.crt` | The local CA certificate (only if `certs/ca.crt` exists) |
| `POST /transcript` | Interim speech |
| `POST /listening {stop?, why?}` | Mic state. `why` is logged, for example the phone's no-words diagnosis |
| `GET /remote/status` | `state` (`idle connecting connected offline unpaired pairing pair-timeout denied`), `paired`, `transport`, `lastError`, `power` (`on off unknown`), `model`, `autoLaunch`, `lastLaunch`, `launcher` (SSE connected) |
| `GET /remote/apps` | Dock app shortcuts |
| `POST /remote/key {key, cmd?}` | Send a key: `UP DOWN LEFT RIGHT ENTER RETURN HOME PLAYPAUSE VOLUP VOLDOWN MUTE …` (whitelisted) |
| `POST /remote/launch {app}` | Launch a dock app by key (`netflix`, …) or `launcher` |
| `POST /remote/power` | `KEY_POWER` when the TV is on, else Wake-on-LAN (`409 no-mac` without `TV_MAC`) |
| `POST /remote/pair` | Start (or retry) pairing; returns the status right away, and the phone polls `/remote/status` |
| `POST /tv/show {chatId, messageId \| index}` | v6.2 Show on TV: brings `GlassHome1.launcher` to the front (REST, no blind keys) if it isn't already, then pushes a `tv-show` SSE event with the answer. Returns `launcher` (`front`/`launched`), `previous` (the dock app that was on screen) and `tvs`. `409 tv-off`, `404 no-chat`/`no-message`, `503` launch failed. JSON only |
| `POST /tv/shown {id}`, `GET /tv/pending` | Launcher only: ack a show / fetch a show it missed while starting (pending shows expire) |
| `POST /tv/back {id}` | Launcher only: relaunch the app that was playing before the last show |

| `POST /remote/launcher {action}` | Launcher-only actions over SSE: `yoyo`, `stats`, `close` |

Key/launch errors: `409` with `error` = `pairing`, `unpaired`, `pair-timeout`, `denied` or `no-mac`; `503 offline`; `400 bad-key` / `bad-app`.

The server is on your LAN with no authentication, so anyone on the Wi-Fi can send it requests (including TV keys). Don't port-forward it.
`/remote/*` and `/tv/*` refuse CORS preflights (`/tv/show` only accepts `application/json`), so web pages on other sites can't drive the TV. Requests are rate-limited per IP.

## Tests

```sh
bash test/run-all.sh         # everything below except the phone test, with all API keys removed and temp data/log dirs (uses GNU `timeout` when available)
node test/parser.test.js     # 25 built-in parser phrases
node test/chats.test.js      # chat storage: files 600, titles, rename, delete, bad ids
node test/play.test.js       # Play X on Y against a fake TV (DIAL + REST + remote keys/IME), fake TMDB, Wikidata and YouTube APIs
node test/stt.test.js        # /stt with fake whisper-cli/afconvert and a fake Gemini; limits, caps, metrics
node test/wol.test.js        # Wake-on-LAN targets, retries, learned MAC, auto-launch after wake
node test/llm.test.js        # LLM client against a fake local OpenAI server (tool loop, memory, 429 fallback)
node test/llm-multiturn.test.js # strict Gemini-shaped multi-turn history (thought signatures, compaction, retry, 30 min memory, lang, overlap)
node test/metrics.test.js; node test/budget.test.js
node test/tv-remote.test.js  # TV remote against a fake Samsung TV (TLS + plain WebSocket, REST): pairing states, no auto re-pair, offline backoff, keys, launch, WOL, routes
node test/tv-power.test.js   # power watch + auto-open: transitions, already running, no relaunch while on, blips, quiet logs
node test/tv-show.test.js    # v6.2 Show on TV: /tv/show launch + push, previous app, tv-off, bad ids, pending replay, /tv/back
node ../tools/test-phone.js  # phone page in headless Chromium at iPhone size: chat bubbles, chats drawer, hold-to-talk recording (fake MediaRecorder) and Web Speech fallback, spoken answers, language, remote, previews (needs Chrome + playwright-core)
```

**macOS:** macOS doesn't ship GNU `timeout`. `run-all.sh` then runs without the per-test time limit (it also picks up
`gtimeout` after `brew install coreutils`). If your copy of the script still calls `timeout` directly, install coreutils or run the test files directly:
`for t in test/*.test.js; do node "$t" || break; done`. They're offline: no keys, no TV, no network needed (run them without
your `.env` loaded).

## Stats & evals

- Every request is timed (LLM calls, tokens, per-tool ms, time to first step, total, fallback hops). The `answer` SSE event and
  the `/ask` response carry a compact `stats` object; each request is appended to `relay/logs/metrics.jsonl` (gitignored, no keys;
  `METRICS=0` disables). `GET /stats` returns today / all-time aggregates (requests, avg/p50/p95, tokens, fallback rate, models).
- TV: a faint stats line appears under the answer panel; **Info** (or Yellow; `i` in a browser) opens a small details card, Back hides it.
- Phone page: tap **Stats** for the last request and today's totals.
- Evals: `node relay/evals/run.js [--brain gemini|groq|ollama|free] [--cases file] [--no-judge] [--delay ms]` runs
  `relay/evals/cases.json` (20 cases, deterministic checks + optional advisory LLM judge) and writes `relay/evals/reports/<stamp>-<brain>.json`
  and `latest.html`. Eval runs don't write to metrics.jsonl unless `EVAL_METRICS=1`.

## Zero-cost guard

Remote LLM calls are capped per Pacific calendar day: `LLM_MAX_REQUESTS_PER_DAY` (default 200 HTTP calls) and
`LLM_MAX_TOKENS_PER_DAY` (default 200000). The counter is kept in memory and in `relay/logs/llm-budget.json` (seeded from today's
`metrics.jsonl` on start, reset at midnight Pacific). Over a cap the relay skips the cloud model and uses Ollama if it's running,
else the built-in parser. The TV stats line then reads "daily AI limit reached". If a provider response mentions billing,
paid tier or payment (or returns HTTP 402), remote calls are refused until you delete `relay/logs/llm-budget.json`. Gemini's
usual free-tier quota 429 ("check your plan and billing details") counts as a rate limit, not a billing signal. Local Ollama is never counted. `GET /status` shows the budget.
A Gemini key from a project without billing enabled stays on the free tier and can't be charged.

## v6: Chats

- The Yo-Yo tab is a chat: your messages on the right, Yo-Yo on the left (glass bubbles), a text box, and the big mic (hold to talk).
- Each chat is a file in `relay/data/chats/<id>.json` (folder 700, files 600, gitignored). It holds the visible messages, the
  model's recent turns and a short rolling summary of older ones. Only the summary + the last 8 turns go to the model, so long chats stay cheap.
- The phone keeps a stable client id and the open chat id in `localStorage`. **+** starts a fresh chat lazily (nothing is saved until
  the first question). ☰ opens the list: tap to open, ✎ to rename, 🗑 twice to delete. The first question becomes the title.
- Answers show what really happened: a "Playing …" / "Opened …" / "Couldn't …" chip, title chips, and a speaker button to hear it again.
- The prompt covers anything (cooking, travel, how things work), not only TV; TV actions are tools it uses when asked.
- Undo: delete `relay/data/chats/` (or single files).

## v6: Speech-to-text (hold-to-talk)

Why: iPhone Safari's `webkitSpeechRecognition` tends to abort after the first press in a Home Screen web app, so v6 records
the audio itself and transcribes it on the relay.


The phone records with `MediaRecorder` (Safari: `audio/mp4`) while you hold the mic and uploads it to `POST /stt`. iPhone Safari only
allows the microphone on a secure page, so recording needs the *HTTPS* page; on plain http the phone uses Safari's own speech
recognition (Web Speech) as before.

| `STT` | Engine |
|---|---|
| `auto` (default) | whisper.cpp if you installed it, else **Gemini** (the default for most setups: it reuses `GEMINI_API_KEY`), else off |
| `whisper` | Local whisper.cpp only (free, offline, private). Audio → 16 kHz mono WAV with macOS's built-in `afconvert` |
| `gemini` | Gemini (same free-tier key; **counted in the same daily caps** as the brain, ~1 request + a few hundred tokens per clip) |
| `off` | No server STT; the phone uses Web Speech |

With `auto`, a whisper failure falls back to Gemini (`STT_FALLBACK=0` to stop that). If `/stt` errors, the phone switches to Web Speech
for the rest of the session. Limits: `STT_MAX_SEC` (30) and `STT_MAX_BYTES` (3 MB) → 413; rate limit per phone → 429. `/stats` has
per-engine counts and median/p90 times; `logs/stt.jsonl` never contains transcripts.

Install whisper.cpp (optional): `bash relay/tools/install-whisper.sh`. It installs only into `~/.glasshome/` (no sudo, no Homebrew):
whisper.cpp v1.9.5 (~10 MB clone, built with Metal), the `small` model (~488 MB) on Apple Silicon or `base` (~148 MB) on Intel, and,
only if `cmake` is missing, Kitware's official cmake (~78 MB download, checksum-verified). Needs Xcode Command Line Tools. Undo:
`rm -rf ~/.glasshome/whisper.cpp ~/.glasshome/cmake`.

| Variable | Default | Meaning |
|---|---|---|
| `STT` | `auto` | `auto`, `whisper`, `gemini`, `off` |
| `STT_FALLBACK` | on | `0` = no Gemini fallback after a whisper error |
| `STT_GEMINI`, `STT_GEMINI_KEY`, `STT_GEMINI_MODEL` | on, brain key, brain model | `STT_GEMINI=0` never uses Gemini for speech |
| `STT_MAX_SEC`, `STT_MAX_BYTES` | `30`, `3145728` | Upload limits |
| `WHISPER_DIR`, `WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_MODEL_NAME` | `~/.glasshome/whisper.cpp`, `build/bin/whisper-cli`, first of small/base/medium | whisper.cpp location |
| `WHISPER_THREADS`, `WHISPER_TIMEOUT_MS`, `WHISPER_PROMPT` | cores, `30000`, app names | Speed / accuracy hints |
| `AFCONVERT` | `/usr/bin/afconvert` | Audio converter (built into macOS) |

## HTTPS (needed for recording on the iPhone)

`bash relay/tools/make-certs.sh YOUR-MAC-IP` makes a private CA and a certificate for that address in `relay/certs/` (keys mode 600,
gitignored; uses the openssl/LibreSSL that ships with macOS). The CA is name-constrained to that address. Restart the relay; it then also listens on
`https://YOUR-MAC-IP:8788/` (`HTTPS_PORT`). On the iPhone: open `http://YOUR-MAC-IP:8787/ca.crt` → Allow → Settings › General › VPN & Device
Management → install *Glass Home Local CA* → Settings › General › About › Certificate Trust Settings → enable it. Then open the
https address and re-add it to the Home Screen. Undo: `rm -rf relay/certs` and remove the profile on the iPhone.

## v6: Play X on Y

Say or type "play Breaking Bad on Netflix", "open Severance on Apple TV", "put Dune on HBO Max",
"play The Office on some streaming service" or "play Innerbloom on YouTube". Every answer says what really happened
("Playing …", "Opened Prime Video, pick the title there", "Couldn't …"); nothing is claimed that the relay didn't see.

| Service | What happens | How |
|---|---|---|
| Netflix | **Plays the title** when Wikidata knows its Netflix id (best effort) | TMDB → Wikidata *Netflix ID* (P1874) → DIAL `m=https://www.netflix.com/watch/<id>&source_type=4`. If Netflix wasn't already running, it lands on **"Who's watching?"**: the relay waits `NETFLIX_PROFILE_WAIT_MS`, presses OK on the highlighted profile (needs the paired remote), waits `NETFLIX_REDIAL_WAIT_MS` and sends the link again. Profile handling is best effort: if your default profile isn't the highlighted one, or the TV is slow, you may need to pick the profile yourself. No id → opens Netflix. |
| YouTube | **Opens the YouTube app** | `YT_MODE=dial` (default). A TV app can't be told to play a specific YouTube video from outside: on tested TVs DIAL `POST /ws/apps/YouTube` answers 403 and deep links only open YouTube's home screen. To play a specific video, **cast it from the YouTube app on your phone**. |
| Prime Video, Disney+, Hulu, HBO Max, Apple TV, Peacock | **Opens the app**; the answer tells you to pick the title there | REST launch of the numeric Samsung app id (below), WebSocket `ed.apps.launch` as a fallback (Spotify: only if you add it, see below) |
| "some / any service" | Picks a service you can watch it on | TMDB watch providers (US, subscription); Netflix first because it can play, then HBO Max, Prime, Disney+, Hulu, Apple TV, Peacock |

Apps are launched with `POST http://TV_IP:8001/api/v2/applications/<id>` using the **numeric Samsung app ids** (`storeIds[0]` in the launcher's `js/apps.js`, or the `dock-apps.json` snapshot when the relay runs without `../js`;
the TV's REST API launches store ids, the Tizen package ids are what the launcher itself uses). REST calls time out after **8 s**
(slow TVs can take several seconds to start an app). Launching needs no pairing; key presses (profile OK) do.

| App | Samsung app id |
|---|---|
| YouTube | `111299001912` |
| Netflix | `3201907018807` |
| Prime Video | `3201910019365` |
| Disney+ | `3201901017640` |
| Hulu | `3201601007625` |
| HBO Max | `3202301029760` |
| Apple TV | `3201807016597` |
| Peacock | `3202006020991` |
| Spotify | `3201606009684` (not in the default dock or the "play on" services; reference id if you add it to `js/apps.js` as `storeIds`) |

Ids can differ by region or firmware: check with `curl http://TV_IP:8001/api/v2/applications/<id>` (it returns JSON when the app
is installed) and edit `dock-apps.json` or the launcher's `js/apps.js` (`node dock-apps.js --write` regenerates the JSON).

**Experimental YouTube search (`YT_MODE=search`, off by default, unreliable):** the relay drives the YouTube app with blind
remote key presses: open it, pick the profile on a cold start, open Search from the side menu, type "song artist" (the system
keyboard via `SendInputString` if the TV sends `ms.remote.imeStart`, else arrow keys on YouTube's own keyboard), submit and press
OK on the first result. It depends on YouTube's current layout and timing, often lands in the wrong place, needs the paired remote,
and the answer only says "Searching YouTube …" (it can't verify what plays). Tune it with the probe below if you want to try it.

No scraping, no unofficial APIs (the YouTube Lounge/pairing API is not used). If the TV is off, it is woken first (Wake-on-LAN)
and the play waits up to `PLAY_WAKE_WAIT_MS`. "Some other song" (search mode) picks a different song by the same artist
(recent plays are remembered in `data/played.json`).

| Variable | Default | Meaning |
|---|---|---|
| `YT_API_KEY`, `YT_DAILY_SEARCHES` | –, `50` | Optional YouTube Data API key (free quota) and daily cap |
| `TV_DIAL_PORT`, `TV_DIAL_BASE`, `TV_DIAL_DISCOVER` | `8080`, –, on | DIAL endpoint; `TV_DIAL_DISCOVER=0` skips SSDP |
| `YT_DIAL_CONFIRM`, `YT_DIAL_CONFIRM_MS` | off, `3500` | `1` = press OK after the DIAL start (if the TV shows a "connect?" prompt) |
| `YT_MODE` | `dial` | `dial` (open YouTube; tries DIAL `v=<id>` when an id is found) or `search` (experimental key-press search) |
| `YT_WAIT_DONE` | `0` | Search mode: `1` = `/ask` waits for the whole key sequence |
| `YT_WIKIDATA` | `1` | `0` = "some other song" doesn't look up a different song on Wikidata |
| `YT_DIAL_ORIGIN` | `https://www.youtube.com` | Origin header for YouTube DIAL (empty = none; without it the TV answers 403) |
| `YT_APP_ID` | `9Ur5IzDKqV.TizenYouTube` | YouTube app id |
| `YT_LAUNCH_WAIT_MS`, `YT_RESUME_WAIT_MS` | `8000`, `2500` | Wait after a cold launch / after bringing a running YouTube forward |
| `YT_PROFILE_ENTER`, `YT_PROFILE_WAIT_MS` | `1`, `4000` | OK on the "who's watching" screen after a cold start (`0` = off) and the wait after it |
| `YT_RUNNING_KEYS` | – | Keys sent first only when YouTube was already running (e.g. `RETURN` to leave a playing video) |
| `YT_SEARCH_KEYS`, `YT_SEARCH_WAIT_MS` | `LEFT,WAIT:600,UP*6,ENTER`, `2000` | Open Search from the side menu, then wait |
| `YT_KEY_GAP_MS`, `YT_KB_GAP_MS` | `350`, `220` | Gap between keys / on-screen keyboard moves |
| `YT_TYPE`, `YT_IME_WAIT_MS`, `YT_IME_END` | `auto`, `1500`, `1` | `auto` (system keyboard if `imeStart` arrives within the wait, else grid), `ime`, `grid`, `none`; `YT_IME_END=0` skips `SendInputEnd` |
| `YT_KEYBOARD`, `YT_KB_START`, `YT_KB_MAX_CHARS` | `abcdefg\|hijklmn\|opqrstu\|vwxyz-'\|___<<<<`, `a`, `40` | YouTube's on-screen keyboard rows (`_` space, `<` delete; a repeated symbol is one wide key), the focused key, max typed characters |
| `YT_SUBMIT_KEYS`, `YT_SUBMIT_IME_KEYS` | `RIGHT,ENTER`, – | Submit after grid typing (first suggestion) / after system-keyboard typing |
| `YT_RESULTS_WAIT_MS`, `YT_PLAY_KEYS` | `3000`, `ENTER` | Wait for results, then play the first one |
| `NETFLIX_PROFILE_ENTER` | `1` | `1` = OK on the profile picker + re-send the link only when Netflix wasn't running; `always`; `0` = off |
| `NETFLIX_PROFILE_WAIT_MS`, `NETFLIX_REDIAL_WAIT_MS` | `5000`, `5000` | Wait before OK / before the second DIAL |
| `NETFLIX_LINK` | `watch` | `title` = open the title page instead of starting playback |
| `PLAY_WAKE_WAIT_MS`, `PLAY_SETTLE_MS`, `PLAY_VERIFY_MS` | `25000`, `5000`, `3000` | Waits around wake / launch / verify |

### Tuning the experimental YouTube search with the probe

Key sequences are `KEY`, `KEY_X`, `KEY*n` and `WAIT:ms`, comma-separated. The probe reads only `YT_*`, `TV_*` and `NETFLIX_*` from `.env`, never prints the token, and logs each step and every IME event:

```
node tools/yt-search-probe.js 'Underwater RÜFÜS DU SOL' --step     # press Enter before each step, q to stop
node tools/yt-search-probe.js 'Underwater RÜFÜS DU SOL' --dry      # print the plan and grid keys, no TV
node tools/yt-search-probe.js 'Underwater RÜFÜS DU SOL' --type=ime # force system keyboard typing
node tools/yt-search-probe.js x --dial=<videoId>                     # DIAL GET + POST without/with Origin
```

Override any setting for one run, e.g. `YT_SEARCH_KEYS='RETURN,LEFT,UP*5,ENTER' node tools/yt-search-probe.js …`, then copy what works into `.env` and restart the relay.

## v6: Wake-on-LAN

The power button (and "play …" when the TV is off) sends the magic packet to the limited broadcast, the TV subnet's broadcast and the
TV's own IP, on ports 9 and 7, `WOL_REPEATS` (3) rounds. Then the relay polls every second for `WOL_WATCH_MS` and the launcher
auto-opens once the TV is on. The MAC comes from `TV_MAC`, or is learned from the TV's own info (`wifiMac`) the first time it's seen on,
and saved in `data/tv.json`. If the TV doesn't wake, turn on TV Settings › General › Network › Expert Settings › **Power On with Mobile**
(the phone shows this hint too). Wi-Fi TVs may not wake from deep standby after a long time off.

## v6.2: TV corner card and "Show on TV"

- **Corner card:** a question asked on the phone appears in a small glass card at the bottom right of the TV (question, answer,
  state orb). It shows only while the launcher is the foreground app (a hidden or suspended launcher ignores the events), never
  takes focus (the arrows and OK keep driving Home) and fades by itself (~8 s after the answer, up to 20 s for long ones, 6 s for
  errors). **Back** closes it, **Play/Pause** opens the full Yo-Yo overlay. Off: `voice: { …, card: false }` in `js/config.js`
  or `?vcard=0` in the launcher URL (phone questions then open the full overlay, as in v6.1).
- **Show on TV:** answers of 250+ characters get a **Show on TV** button on the phone. The first tap arms it and warns that the TV
  will switch to Home; the second tap calls `POST /tv/show`. The relay brings the launcher to the front over REST (no blind key
  presses) and pushes the answer; the TV shows a centred, scrollable panel (**Up/Down** scroll, **Back** closes, **OK** = "Back to
  <app>", which calls `POST /tv/back` to relaunch the app that was on screen, when the relay saw one).
- The launcher acks with `POST /tv/shown`; a show that arrives while Home is still starting is replayed on connect or via `GET /tv/pending`.
- **Limit:** a Tizen web app can't draw over other apps, so nothing appears on top of Netflix, YouTube and so on. That's why
  Show on TV brings Home forward, and why the corner card only appears while Home is on screen.

## Data and privacy

`relay/data/` (chats, learned TV MAC, played songs, YouTube quota), `relay/logs/` (metrics, budget, STT timings), `relay/certs/`,
`relay/.secrets/` and `.env` are gitignored and created with owner-only permissions where they hold anything personal.
`CHATS_DIR`, `DATA_DIR`, `LOG_DIR` (STT log), `METRICS_DIR` (metrics) move them (the tests use temp dirs).
