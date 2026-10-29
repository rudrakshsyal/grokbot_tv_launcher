# Voice relay (Glass Home launcher v4/v5)

A small Node server that runs on a Mac on your home network (any always-on computer with Node works; the examples call its address `YOUR-MAC-IP`). It has **no npm dependencies**.
- Your **iPhone** is a TV remote and the microphone. The phone page (add it to the Home Screen) has three tabs: **Remote** (D-pad, Back, Home, Play/Pause, volume, power, app shortcuts), **Yo-Yo** (hold the mic and speak; Safari speech recognition, typing also works) and **Home** (smart-home placeholder).
- The relay works out the answer and streams each step to the **TV** over Server-Sent Events (`GET /events`).
- The TV shows the "Orb + Timeline" overlay. When the relay can't be reached, the TV feature stays hidden.

Requirement: **Node.js 14 or newer on the Mac.** Run `node -v`; if Node is missing, install it from https://nodejs.org or with `brew install node`.

## Run it

```sh
cd relay
TV_IP=192.168.1.50 TMDB_API_KEY=… OMDB_API_KEY=… GEMINI_API_KEY=… node server.js   # your TV's IP, your own keys
```

The startup output lists the brain chain, which keys are present and the phone URL. Then:

- **iPhone**: in Safari, open `http://YOUR-MAC-IP:8787/`. Tap Share → **Add to Home Screen** (re-add it if you had the old icon), and allow the microphone when asked.
  - **Yo-Yo tab: press and hold** the mic while you talk, release to send. Slide your finger off the button to cancel.
    Quick glitches (Safari stopping early, "no speech", a dropped network) restart quietly while you hold, up to 3 times.
    Each press uses a fresh recognizer and waits for the previous one to shut down. If a press hears nothing it says
    "Didn't catch that, hold and try again" and puts a short diagnosis in the Mac log (the `idle` line after `listening`).
  - **Speak answers** is on by default: the phone reads a short version of each answer (the first 2 sentences) in the
    iPhone's own voice, which is free. Holding the mic stops the voice. Tap the speaker icon in the answer to hear it again.
  - **English / हिन्दी / Hinglish** sets the recognition language, the reply language and the voice
    (Samantha or Ava; Lekha for Hindi; Rishi or Veena for en-IN). Better voices: iPhone Settings › Accessibility ›
    Spoken Content › Voices › download an *Enhanced* or *Premium* voice.
  - **New chat** clears what Yo-Yo remembers for this phone.
- **TV**: the launcher connects to `config.voice.relay` (set it to `http://YOUR-MAC-IP:8787` in `js/config.js`; empty = voice hidden).
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
| `WEATHER_LAT`, `WEATHER_LON`, `WEATHER_PLACE` | example: San Jose, CA (`37.3382`, `-121.8863`) | Open-Meteo forecast (°F). Set these to your own location |
| `HOME_TZ` | `America/Los_Angeles` | IANA time zone Yo-Yo uses for "now" |
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
MAC; your router's DHCP lease list also shows it) and turn on TV Settings → General → Network → Expert Settings → **Power On with Mobile**.
When the TV is reachable, the power button sends `KEY_POWER` (off). Otherwise it sends the magic packet.

App shortcuts come from the launcher's dock (`js/config.js` + `js/apps.js`). If those files aren't next to the relay, the relay uses `dock-apps.json`;
`node dock-apps.js --write` regenerates that file. **Glass Home** launches `GlassHome1.launcher`. **Yo-Yo on TV** sends an SSE
`{type:'remote', action:'yoyo'}` to the launcher (handled in `js/voice.js`; actions `yoyo`, `stats`, `close`).

| Variable | Default | Meaning |
|---|---|---|
| `TV_IP` | – (required for the remote) | TV address, e.g. `192.168.1.50` (give it a DHCP reservation). Empty = Remote tab and auto-open stay off; Yo-Yo still works |
| `TV_MAC` | – | TV MAC for Wake-on-LAN (`aa:bb:cc:dd:ee:ff`) |
| `TV_WOL_ADDR` | `255.255.255.255` | Broadcast address for the magic packet (e.g. `192.168.1.255`) |
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

Undo / unpair: delete `relay/.secrets/tv-token.json` and remove "Glass Home Remote" in Device Connection Manager. Running an older checkout of
`relay/` restores the old phone page; the TV app does not change.

Icons: `python3 tools/make-remote-icon.py` (from the launcher root, needs Pillow) regenerates `relay/icons/icon-{180,192,512}.png`.

## Endpoints

| Method and path | What it does |
|---|---|
| `GET /` | Phone page |
| `GET /events` | SSE stream for the TV |
| `GET /status` | Status (JSON) |
| `GET /last` | Last answer |
| `POST /ask {text, client?, lang?}` | Waits for the answer. `lang` is `en-US`, `hi-IN` or `en-IN`. The answer includes `spoken`, a short TTS version. A newer question from the same phone replaces the old one, which returns `superseded` |
| `POST /chat/reset {client}` | Forget this phone's conversation |
| `POST /transcript` | Interim speech |
| `POST /listening {stop?, why?}` | Mic state. `why` is logged, for example the phone's no-words diagnosis |
| `GET /remote/status` | `state` (`idle connecting connected offline unpaired pairing pair-timeout denied`), `paired`, `transport`, `lastError`, `power` (`on off unknown`), `model`, `autoLaunch`, `lastLaunch`, `launcher` (SSE connected) |
| `GET /remote/apps` | Dock app shortcuts |
| `POST /remote/key {key, cmd?}` | Send a key: `UP DOWN LEFT RIGHT ENTER RETURN HOME PLAYPAUSE VOLUP VOLDOWN MUTE …` (whitelisted) |
| `POST /remote/launch {app}` | Launch a dock app by key (`netflix`, …) or `launcher` |
| `POST /remote/power` | `KEY_POWER` when the TV is on, else Wake-on-LAN (`409 no-mac` without `TV_MAC`) |
| `POST /remote/pair` | Start (or retry) pairing; returns the status right away, and the phone polls `/remote/status` |

Key/launch errors: `409` with `error` = `pairing`, `unpaired`, `pair-timeout`, `denied` or `no-mac`; `503 offline`; `400 bad-key` / `bad-app`.
| `POST /remote/launcher {action}` | Launcher-only actions over SSE: `yoyo`, `stats`, `close` |

The server is on your LAN with no authentication, so anyone on the Wi-Fi can send it requests (including TV keys). Don't port-forward it.
`/remote/*` only accepts `application/json` POSTs and refuses CORS preflights, so web pages on other sites can't drive the TV. Requests are rate-limited per IP.

## Tests

```sh
node test/parser.test.js     # 20 built-in parser phrases
node test/llm.test.js        # LLM client against a fake local OpenAI server (tool loop, memory, 429 fallback)
node test/llm-multiturn.test.js # strict Gemini-shaped multi-turn history (thought signatures, compaction, retry, 30 min memory, lang, overlap)
node test/metrics.test.js; node test/budget.test.js
node test/tv-remote.test.js  # TV remote against a fake Samsung TV (TLS + plain WebSocket, REST): pairing states, no auto re-pair, offline backoff, keys, launch, WOL, routes
node test/tv-power.test.js   # power watch + auto-open: transitions, already running, no relaunch while on, blips, quiet logs
node ../tools/test-phone.js  # phone page in headless Chromium at iPhone size: hold-to-talk incl. iOS recognizer quirks, spoken answers, language, New chat, remote, previews (needs Chrome + playwright-core)
```

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
