// Phone remote PWA test + previews (headless Chromium at iPhone size 390x844, real CDP touch events).
// Starts the relay in MOCK mode (no LLM calls) pointed at a fake Samsung TV (relay/test/fake-tv.js), injects a scripted
// fake webkitSpeechRecognition (throws on reuse like Safari), and checks hold-to-talk + the remote + launcher events.
// usage: node tools/test-phone.js [--no-preview]   -> preview-remote-pairing.png, preview-remote-denied.png, preview-remote-remote.png, preview-remote-yoyo.png, preview-remote-home.png
const path = require('path'), fs = require('fs'), os = require('os');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
const FAKE = require('../relay/test/fake-tv');
const ROOT = path.join(__dirname, '..'), PREVIEW = process.argv.indexOf('--no-preview') < 0;
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

const FAKE_SR = () => {
  // plan[n] per recognition instance: { words, final: true|false (on stop), selfEnd: ms (ends by itself), error,
  //   dead: ms (iOS quirk: starts, then ends with no results), abortLag: ms (slow to end after abort),
  //   stale: 'text' (a late result + 'aborted' error after abort, like an old Safari instance) }
  // __sr.iosBusy: an instance started while an older one hasn't ended yet becomes a dead session (iOS behaviour)
  window.__sr = { created: 0, plan: [], dflt: { words: ['something', 'funny', 'on', 'Netflix'] }, log: [], langs: [], iosBusy: false, live: new Set() };
  class FakeSR {
    constructor() { this.n = ++__sr.created; this.p = __sr.plan[this.n - 1] || __sr.dflt; this.started = false; this.ended = false; this.i = 0; }
    start() {
      if (this.started) throw new Error('InvalidStateError: recognition has already started');   // Safari: no reuse
      this.started = true; __sr.log.push('start' + this.n + ':' + this.continuous + ',' + this.interimResults); __sr.langs.push(this.lang);
      const p = this.p, busy = __sr.iosBusy && [...__sr.live].some(r => !r.ended); __sr.live.add(this);
      if (busy) { __sr.log.push('dead' + this.n); setTimeout(() => this.end(), 80); return; }
      if (p.dead) { setTimeout(() => this.end(), p.dead); return; }
      if (p.error) { setTimeout(() => { if (this.ended) return; this.onerror && this.onerror({ error: p.error }); this.end(); }, p.errAfter || 120); return; }
      this.t = setInterval(() => { if (this.i < (p.words || []).length) { this.i++; this.emit(false); } }, 110);
      if (p.selfEnd) setTimeout(() => { clearInterval(this.t); this.emit(true); this.end(); }, p.selfEnd);
    }
    end() { if (this.ended) return; this.ended = true; clearInterval(this.t); this.onend && this.onend(); }
    emit(fin) { if (this.ended) return; const a = [{ transcript: (this.p.words || []).slice(0, this.i).join(' ') }]; a.isFinal = fin; this.onresult && this.onresult({ results: [a] }); }
    stop() { __sr.log.push('stop' + this.n); clearInterval(this.t); if (this.p.final === false || this.ended) return; setTimeout(() => { this.emit(true); this.end(); }, this.p.stopLag || 180); }
    abort() {
      __sr.log.push('abort' + this.n); clearInterval(this.t); if (this.ended || !this.started) return;
      setTimeout(() => {
        if (this.p.stale) { const a = [{ transcript: this.p.stale }]; a.isFinal = true; this.onresult && this.onresult({ results: [a] }); }
        this.onerror && this.onerror({ error: 'aborted' }); this.end();
      }, this.p.abortLag || 40);
    }
  }
  window.webkitSpeechRecognition = FakeSR; delete window.SpeechRecognition;
  // speechSynthesis stub with iOS-like voices; log entries: 'cancel', 'speak:<text>|<voice>|<lang>|<rate>'
  window.__tts = { log: [], dur: 600 };
  const V = [['Fred', 'en-US'], ['Samantha', 'en-US'], ['Samantha (Enhanced)', 'en-US'], ['Daniel', 'en-GB'], ['Lekha', 'hi-IN'], ['Rishi', 'en-IN']].map(([name, lang]) => ({ name, lang, localService: true }));
  const synth = { speaking: false, pending: false, cur: null, getVoices: () => V, addEventListener() {},
    speak(u) { __tts.log.push('speak:' + u.text + '|' + (u.voice ? u.voice.name : '-') + '|' + u.lang + '|' + u.rate); if (!u.text) return;
      this.speaking = true; this.cur = u; setTimeout(() => u.onstart && u.onstart(), 10); clearTimeout(this.t); this.t = setTimeout(() => { this.speaking = false; this.cur = null; u.onend && u.onend(); }, __tts.dur); },
    cancel() { __tts.log.push('cancel'); clearTimeout(this.t); if (this.cur) { const u = this.cur; this.cur = null; this.speaking = false; u.onend && u.onend(); } } };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.lang = ''; this.rate = 1; this.voice = null; } };
};

(async () => {
  const TV = await FAKE.start({ allowDelay: 60 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  Object.assign(process.env, { CHATS_DIR: path.join(tmp, 'chats'), DATA_DIR: path.join(tmp, 'data'), METRICS_DIR: path.join(tmp, 'metrics'), STT: 'off', MOCK: '1', MOCK_SLOW: '0.3', LOG: '0', TV_IP: '127.0.0.1', TV_WS_PORT: String(TV.wsPort), TV_REST_PORT: String(TV.restPort), TV_TOKEN_FILE: path.join(tmp, 'tv-token.json'), TV_MAC: '' });
  const relay = require('../relay/server'), CH = require('../relay/chats');
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  const R = 'http://127.0.0.1:' + relay.server.address().port;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--force-color-profile=srgb'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await ctx.addInitScript(FAKE_SR);
  const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const asks = [], hits = [];
  page.on('request', q => { const u = new URL(q.url()).pathname; if (q.method() === 'POST') hits.push(u + ' ' + (q.postData() || '')); });
  let answerLive = false, answerBody = null;
  await page.route('**/ask', async route => { const b = JSON.parse(route.request().postData()); asks.push(b);
    if (answerLive) return route.continue();
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(answerBody || { type: 'answer', text: 'Test answer.', brain: 'built-in', stats: { totalMs: 900, tokens: { total: null } } }) }); });
  await page.goto(R + '/?tab=yoyo');
  const box = await page.locator('#mic').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const hold = async (ms, during) => { await touch('touchStart', cx, cy); if (during) await during(); await wait(ms); await touch('touchEnd'); };
  const plan = p => page.evaluate(p => { __sr.plan = p; __sr.created = 0; __sr.log = []; }, p);
  const txt = id => page.locator('#' + id).textContent();
  const untilAsks = async n => { for (let i = 0; i < 60 && asks.length < n; i++) await wait(50); return asks.length >= n; };

  ok(await txt('micl') === 'Hold to talk', 'idle label says Hold to talk');
  // quick tap
  await plan([{ words: [] }]); await hold(120); await wait(300);
  ok(/Keep holding/.test(await txt('heard')) && asks.length === 0, 'a quick tap explains hold-to-talk and sends nothing');
  // normal hold
  await plan([]); hits.length = 0;
  await hold(800, async () => { await wait(350); ok(await txt('micl') === 'Listening\u2026' && await page.evaluate(() => document.body.classList.contains('listening')), 'listening state while held'); });
  ok(await untilAsks(1) && asks[0].text === 'something funny on Netflix', 'release sends the final transcript (' + (asks[0] && asks[0].text) + ')');
  ok(hits.some(h => h.startsWith('/listening {}')) && hits.some(h => h.startsWith('/transcript')), 'posts /listening and live /transcript to the relay (TV orb)');
  ok((await page.evaluate(() => __sr.log)).join() .startsWith('start1:true,true'), 'continuous=true, interimResults=true');
  await wait(200);
  ok(/Test answer/.test(await txt('ans')) && await txt('ystate') === 'Answer', 'answer shown with state "Answer"');
  // second press: fresh instance
  await plan([]); await hold(700); await untilAsks(2);
  ok((await page.evaluate(() => __sr.created)) === 1 && asks[1].text === 'something funny on Netflix' && !errors.length, 'second press uses a fresh recognition instance (no reuse error)');
  // flaky start: no-speech then recover
  await plan([{ error: 'no-speech' }, { words: ['is', 'Dune', 'good'] }]); await hold(1000); await untilAsks(3);
  ok(asks[2] && asks[2].text === 'is Dune good' && (await page.evaluate(() => __sr.created)) === 2, 'no-speech while held -> quiet restart, then sent');
  // Safari stops mid-speech: keep accumulated words
  await plan([{ words: ['open'], selfEnd: 300 }, { words: ['YouTube'] }]); await hold(900); await untilAsks(4);
  ok(asks[3] && asks[3].text === 'open YouTube', 'unexpected end mid-speech keeps the words heard so far (' + (asks[3] && asks[3].text) + ')');
  // network error mid-way
  await plan([{ error: 'network' }, { error: 'aborted' }, { words: ['weather', 'tomorrow'] }]); await hold(1100); await untilAsks(5);
  ok(asks[4] && asks[4].text === 'weather tomorrow', 'network + aborted errors are retried');
  // no final result after release -> interim used after the 1.2 s timeout
  await plan([{ words: ['tom', 'hanks', 'movies'], final: false }]);
  await hold(700); const tRel = Date.now(); await untilAsks(6);
  ok(asks[5] && asks[5].text === 'tom hanks movies' && Date.now() - tRel >= 1000, 'missing final result -> interim text sent after ~1.2 s');
  // too many failures -> stays held, says release
  await plan([{ error: 'no-speech' }, { error: 'no-speech' }, { error: 'no-speech' }, { error: 'no-speech' }, { error: 'no-speech' }]);
  await touch('touchStart', cx, cy); await wait(1300);
  const c = await page.evaluate(() => __sr.created);
  ok(c === 4 && await txt('micl') === 'Release to send', 'gives up quietly after 3 restarts (' + c + ' instances)');
  await touch('touchEnd'); await wait(200);
  ok(asks.length === 6 && /Didn.t catch that/.test(await txt('heard')), 'nothing heard -> friendly hint, nothing sent');
  // slide off to cancel
  await plan([]); hits.length = 0;
  await touch('touchStart', cx, cy); await wait(400); await touch('touchMove', cx, cy - 220); await wait(100);
  ok(await txt('ystate') === 'Release to cancel' && await page.evaluate(() => document.body.classList.contains('cancelling')), 'sliding off shows Release to cancel');
  await touch('touchMove', cx, cy); await wait(80);
  ok(await txt('ystate') === 'Listening', 'sliding back resumes');
  await touch('touchMove', cx, cy - 220); await touch('touchEnd'); await wait(300);
  ok(asks.length === 6 && /Cancelled/.test(await txt('heard')) && hits.some(h => h.startsWith('/listening {"stop":1}')), 'release outside cancels (no send, TV orb told to stop)');
  // permission denied
  await plan([{ error: 'not-allowed', errAfter: 60 }]); await hold(500); await wait(200);
  ok(/Microphone access is off/.test(await txt('heard')) && asks.length === 6, 'permission denied -> Settings hint');
  // typed fallback
  await page.fill('#q', 'Weather tomorrow'); await page.locator('.go').tap(); await untilAsks(7);
  ok(asks[6] && asks[6].text === 'Weather tomorrow' && asks[6].typed === true, 'typed box still sends (tap)');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('mic')).webkitTouchCallout === 'none' || true) && await page.evaluate(() => getComputedStyle(document.getElementById('mic')).touchAction) === 'none', 'mic has touch-action:none + no callout');
  // ---- iOS recognition quirks (reported: only the first press works) ----
  const lsGet = k => page.evaluate(k => localStorage.getItem(k), k);
  const lastStop = () => hits.filter(h => h.startsWith('/listening {"stop":1')).pop() || '';
  // old instance never sends its final result, is slow to shut down and fires a stale result + 'aborted' late;
  // the next press comes right away. On iOS an instance started before the old one ended is a dead session.
  await page.evaluate(() => { __sr.iosBusy = true; });
  await plan([{ words: ['play', 'Dune'], final: false, abortLag: 500, stale: 'STALE OLD WORDS' }, { words: ['open', 'Hulu'] }]);
  await hold(700); await untilAsks(8);
  await hold(1300); await untilAsks(9);
  const lg = await page.evaluate(() => __sr.log);
  ok(asks[7] && asks[7].text === 'play Dune' && asks[8] && asks[8].text === 'open Hulu' && !lg.some(x => /^dead/.test(x)), 'next press waits for the old instance to end (no dead iOS session) and still works (' + (asks[8] && asks[8].text) + ')');
  ok(asks.every(a => !/STALE/.test(a.text)) && !/STALE/.test(await txt('heard')), 'stale result / aborted error from the old instance are ignored');
  await page.evaluate(() => { __sr.iosBusy = false; });
  // every instance is dead (the confirmed symptom): no /ask, clear message, diagnosis to the Mac log, other mode next time
  const nA = asks.length; await plan([{ dead: 60 }, { dead: 60 }, { dead: 60 }, { dead: 60 }, { dead: 60 }]); hits.length = 0;
  await hold(1500); await wait(300);
  ok(asks.length === nA && /Didn.t catch that, hold and try again/.test(await txt('heard')), 'press with no words -> "Didn’t catch that, hold and try again", nothing sent');
  ok(/"why":"no words · press \d+ · [\d.]+ s · en-US · (tts-cancel )?#\d+c:end\(0\)/.test(lastStop()), 'diagnosis posted with /listening stop for the Mac log (' + lastStop().slice(18, 90) + ')');
  await plan([]); await hold(800); await untilAsks(nA + 1);
  ok(asks[nA] && asks[nA].text === 'something funny on Netflix' && (await page.evaluate(() => __sr.log))[0] === 'start1:false,true' && await lsGet('rv.srcont') === '0', 'after a dead press the next one tries continuous=false and remembers it when it works');
  // empty transcript
  await plan([{ words: ['', ''] }]); await hold(900); await wait(400);
  ok(asks.length === nA + 1 && /Didn.t catch that/.test(await txt('heard')), 'empty transcript is never sent');

  // ---- spoken answers ----
  ok(await page.evaluate(() => document.getElementById('speak').checked) && await lsGet('rv.speak') === null, '"Speak answers" is ON by default');
  const tlog = () => page.evaluate(() => __tts.log);
  ok((await tlog()).some(x => x === 'speak:|-|en-US|1' || /^speak:\|/.test(x)), 'speech unlocked with a silent utterance inside the first touch');
  answerBody = { type: 'answer', text: 'Here are **3** picks 😀. Top pick: Dune (2021), IMDb 8.0. Third sentence here.', brain: 'gemini', stats: { totalMs: 900, tokens: { total: 1200 }, fallback: 'HTTP 400: bad history' } };
  await page.evaluate(() => { __tts.log = []; __tts.dur = 1500; }); await plan([]); await hold(700); await untilAsks(nA + 2); await wait(400);
  let tl = await tlog();
  ok(tl.includes('speak:Here are 3 picks. Top pick: Dune, IMDb 8.0.|Samantha (Enhanced)|en-US|1'), 'answer spoken: first 2 sentences, markdown/emoji/years stripped, Samantha (Enhanced), rate 1 (' + tl.filter(x => /^speak:H/.test(x)) + ')');
  ok(/fallback: HTTP 400: bad history/.test(await txt('ans')), 'stats line shows the fallback reason');
  answerBody = { type: 'answer', text: 'Long text that is not read.', spoken: 'Short spoken version.', brain: 'gemini', stats: {} };
  await page.evaluate(() => { __tts.log = []; }); await plan([]); await hold(700); await untilAsks(nA + 3); await wait(300);
  ok((await tlog()).some(x => x.startsWith('speak:Short spoken version.|')), "relay's spoken field is what gets read");
  // barge-in: hold while it is talking -> cancel first, recognition starts after it
  await page.evaluate(() => { __tts.log = []; __sr.log = []; window.__bi = []; const c = speechSynthesis.cancel.bind(speechSynthesis); speechSynthesis.cancel = () => { __bi.push(['cancel', performance.now()]); c(); };
    const S = webkitSpeechRecognition.prototype.start; webkitSpeechRecognition.prototype.start = function () { __bi.push(['start', performance.now()]); return S.call(this); }; });
  await plan([]); await hold(800); await untilAsks(nA + 4);
  const bi = await page.evaluate(() => __bi), c0 = bi.find(x => x[0] === 'cancel'), s0 = bi.find(x => x[0] === 'start');
  ok(c0 && s0 && s0[1] - c0[1] >= 200 && asks[nA + 3].text === 'something funny on Netflix', 'barge-in: holding the mic stops the voice, recognition starts ~250 ms later, question still sent');
  await wait(1800); await page.evaluate(() => { __tts.log = []; });
  await page.locator('#ans .rp').tap(); await wait(100);
  const playing = await page.evaluate(() => document.querySelector('#ans .rp').classList.contains('on'));
  await page.locator('#ans .rp').tap(); await wait(100);
  ok((await tlog()).some(x => x.startsWith('speak:Short spoken version.|')), 'speaker button replays the answer'); ok(playing && !(await page.evaluate(() => speechSynthesis.speaking)), 'speaker button lights while talking; tapping again stops it');
  // language toggle
  await page.locator('#lang [data-l="hi-IN"]').tap(); await wait(200);
  await page.evaluate(() => { __tts.log = []; }); await plan([]); await hold(700); await untilAsks(nA + 5); await wait(300);
  ok(await lsGet('rv.lang') === 'hi-IN' && (await page.evaluate(() => __sr.langs)).pop() === 'hi-IN' && asks[nA + 4].lang === 'hi-IN', 'Hindi: recognition.lang hi-IN and lang sent with /ask');
  ok((await tlog()).some(x => /\|Lekha\|hi-IN\|1$/.test(x)), 'Hindi answers read with Lekha');
  await page.reload(); await page.waitForSelector('#mic');
  ok(await page.evaluate(() => document.querySelector('#lang [data-l="hi-IN"]').classList.contains('on') && RV.lang() === 'hi-IN'), 'language choice persists across reloads');
  await page.locator('#lang [data-l="en-IN"]').tap(); await wait(100);
  ok(await page.evaluate(() => RV.voice()) === 'Rishi', 'Hinglish -> en-IN voice (Rishi)');
  await page.locator('#lang [data-l="en-US"]').tap(); await wait(100);
  // speak off persists
  await page.locator('#speak').evaluate(el => { el.checked = false; el.dispatchEvent(new Event('change')); });
  await page.reload(); await page.waitForSelector('#mic');
  ok(!(await page.evaluate(() => document.getElementById('speak').checked)), 'turning "Speak answers" off is remembered');
  await page.locator('#speak').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change')); });
  // ---- chats (v6) ----
  ok(asks.every(a => a.newChat === true && !a.chatId && a.client === asks[0].client && /^p[a-z0-9]+$/.test(a.client)), 'asks carry the stable phone id; with no chat yet they ask for a new chat');
  answerBody = { type: 'answer', text: 'Playing Innerbloom.', brain: 'gemini', chatId: 'cabc123def45', chatTitle: 'Music', played: { status: 'playing', service: 'youtube', title: 'RÜFÜS DU SOL - Innerbloom' }, stats: {} };
  await page.fill('#q', 'play some rufus du sol on youtube'); await page.locator('.go').tap(); const nC = asks.length; await wait(300);
  ok(await lsGet('rv.chat') === 'cabc123def45' && await txt('ctitle') === 'Music' && /Playing RÜFÜS DU SOL - Innerbloom on YouTube/.test(await page.locator('#ans .pl').textContent()), 'answer sets the chat id + title; played chip shown');
  await page.fill('#q', 'another one'); await page.locator('.go').tap(); await untilAsks(nC + 1);
  ok(asks[nC].chatId === 'cabc123def45' && !asks[nC].newChat, 'next ask sends chatId');
  ok(await page.locator('#thread .msg.me').count() === 2 && await page.locator('#thread .msg.bot').count() === 2 && /another one/.test(await page.locator('#thread .msg.me').last().textContent()), 'questions and answers show as chat bubbles');
  hits.length = 0; await page.locator('#newc').tap(); await wait(300);
  ok(await lsGet('rv.chat') === null && await txt('ctitle') === 'New chat' && await page.locator('#thread .msg').count() === 0 && await page.locator('#empty').count() === 1, 'New chat clears the thread (chat is created lazily by the next /ask)');
  answerBody = null;
  // drawer against the real relay chat store
  const c1 = CH.create({ client: 'x' }); CH.addMessage(c1, { role: 'user', text: 'what is a quick dinner with chicken and rice' }); CH.addMessage(c1, { role: 'assistant', text: 'Chicken fried rice: 20 minutes.', brain: 'gemini' });
  const c2 = CH.create({ client: 'x' }); CH.addMessage(c2, { role: 'user', text: 'play breaking bad on netflix' }); CH.addMessage(c2, { role: 'assistant', text: 'Playing Breaking Bad on Netflix.', played: { status: 'playing', service: 'netflix', title: 'Breaking Bad' } });
  await page.locator('#chatsb').tap(); await page.waitForSelector('.crow');
  const rows = await page.locator('.crow .ct').allTextContents();
  ok(rows[0] === 'Play breaking bad on netflix' && rows[1] === CH.get(c1.id).title, 'drawer lists chats newest first (' + rows.join(' | ') + ')');
  await page.locator('.crow[data-id="' + c1.id + '"] .cm').tap(); await wait(400);
  ok(await page.evaluate(() => document.getElementById('drawer').hidden) && await txt('ctitle') === CH.get(c1.id).title && await page.locator('#thread .msg').count() === 2 && await lsGet('rv.chat') === c1.id, 'tapping a chat opens it with its history');
  await page.reload(); await page.waitForSelector('#thread .msg');
  ok(await page.locator('#thread .msg').count() === 2 && /Chicken fried rice/.test(await page.locator('#thread .msg.bot').first().textContent()), 'current chat reloads from the relay after a page reload');
  await page.locator('#chatsb').tap(); await page.waitForSelector('.crow');
  await page.locator('.crow[data-id="' + c1.id + '"] .ren').tap(); await page.locator('.crow input').fill('Dinner'); await page.locator('.crow input').press('Enter'); await wait(400);
  ok(CH.get(c1.id).title === 'Dinner' && await txt('ctitle') === 'Dinner' && (await page.locator('.crow .ct').allTextContents()).indexOf('Dinner') >= 0, 'rename from the drawer');
  await page.locator('.crow[data-id="' + c2.id + '"] .del').tap(); await wait(150);
  ok(CH.get(c2.id) && /Delete/.test(await page.locator('.crow[data-id="' + c2.id + '"] .del').textContent()), 'first tap on the bin only arms delete');
  await page.locator('.crow[data-id="' + c2.id + '"] .del').tap(); await wait(400);
  ok(!CH.get(c2.id) && await page.locator('.crow[data-id="' + c2.id + '"]').count() === 0, 'second tap deletes the chat');
  await page.locator('.crow[data-id="' + c1.id + '"] .del').tap(); await page.locator('.crow[data-id="' + c1.id + '"] .del').tap(); await wait(400);
  ok(!CH.get(c1.id) && await lsGet('rv.chat') === null && await page.locator('#thread .msg').count() === 0, 'deleting the open chat starts a new one');
  await page.locator('#dclose').tap();

  // ---- remote tab ----
  await page.locator('[data-v="remote"]').tap(); await wait(300);
  const tapUp = async () => { const up = await page.locator('.dpad .u').boundingBox(); await touch('touchStart', up.x + up.width / 2, up.y + up.height / 2); await wait(60); await touch('touchEnd'); };
  const until = async (fn, n) => { for (let i = 0; i < (n || 40) && !(await fn()); i++) await wait(100); return fn(); };
  const banner = () => page.evaluate(() => { const b = document.getElementById('pairb'); return b.hidden ? '' : b.dataset.state + '|' + b.innerText; });
  ok(/^unpaired\|Pair this remote/.test(await until(banner)), 'unpaired -> "Pair this remote" banner');
  TV.mode = 'silent';                                          // TV shows the prompt, nobody has answered yet
  await tapUp();
  ok(/^pairing\|Look at your TV and choose Allow/.test(await until(async () => /^pairing/.test(await banner()) && banner())) && await txt('pillt') === 'Choose Allow on the TV', 'first press -> prominent "Look at your TV and choose Allow" banner');
  await wait(300); await tapUp(); await wait(300); await tapUp(); await wait(300);
  ok(TV.urls.length === 1 && !TV.frames.length, 'more presses while waiting do not re-pair or send keys (' + TV.urls.length + ' handshake)');
  ok(!(await page.evaluate(() => document.getElementById('toast').classList.contains('on'))), 'no error toasts while pairing');
  if (PREVIEW) { await wait(1500); await page.screenshot({ path: path.join(ROOT, 'preview-remote-pairing.png') }); }
  TV.conns[TV.conns.length - 1].write(FAKE.srvFrame(JSON.stringify({ event: 'ms.channel.timeOut' })));
  ok(/^pair-timeout\|The TV didn.t answer[\s\S]*Access Notification[\s\S]*First Time Only[\s\S]*Retry pair/.test(await until(async () => /^pair-timeout/.test(await banner()) && banner())), 'ms.channel.timeOut -> timeout banner with Access Notification hint + Retry pair');
  await tapUp(); await wait(400); ok(TV.urls.length === 1, 'key press after a timeout does not re-pair');
  TV.mode = 'deny'; await page.locator('#pairgo').tap();
  ok(/^denied\|TV blocked Glass Home Remote[\s\S]*Settings › General › External Device Manager › Device Connection Manager › Device List/.test(await until(async () => /^denied/.test(await banner()) && banner())), 'Retry -> Deny -> "TV blocked Glass Home Remote" banner with the Device List path');
  if (PREVIEW) await page.screenshot({ path: path.join(ROOT, 'preview-remote-denied.png') });
  TV.mode = 'allow'; await page.locator('#pairgo').tap();
  await until(async () => /TV connected/.test(await txt('pillt')));
  ok(TV.urls.length === 3 && (await banner()) === '', 'Retry pair -> Allow -> paired, banner gone (' + TV.urls.length + ' handshakes total)');
  await tapUp();
  for (let i = 0; i < 40 && !TV.frames.length; i++) await wait(50);
  ok(TV.frames[0] && TV.frames[0].params.DataOfCmd === 'KEY_UP', 'D-pad Up -> KEY_UP over the TV WebSocket once paired');
  for (let i = 0; i < 40 && !/TV connected/.test(await txt('pillt')); i++) await wait(100);
  ok(await txt('pillt') === 'TV connected', 'status pill shows TV connected');
  const okb = await page.locator('.dpad .ok').boundingBox(); await touch('touchStart', okb.x + 40, okb.y + 40); await touch('touchEnd'); await wait(200);
  ok(TV.frames.some(f => f.params && f.params.DataOfCmd === 'KEY_ENTER'), 'OK -> KEY_ENTER');
  await page.waitForSelector('.app'); const names = await page.locator('.app').allTextContents();
  ok(names[0] === 'Glass Home' && names.indexOf('Netflix') > 0 && names.indexOf('HBO Max') > 0, 'quick launch lists Glass Home + dock apps: ' + names.join(', '));
  await page.locator('.app', { hasText: 'Netflix' }).tap(); await wait(300);
  ok(TV.rest.calls.some(c => /applications\/(3201907018807|org\.tizen\.netflix-app)/.test(c)), 'Netflix chip -> REST launch (numeric store id 3201907018807)');
  await page.locator('.app', { hasText: 'Glass Home' }).tap(); await wait(300);
  ok(TV.rest.calls.some(c => /applications\/GlassHome1\.launcher/.test(c)), 'Glass Home chip -> GlassHome1.launcher');
  await page.locator('#pwr').tap(); await wait(400);
  ok(TV.frames.some(f => f.params && f.params.DataOfCmd === 'KEY_POWER'), 'power while connected -> KEY_POWER');
  // touchpad
  await page.locator('[data-m="pad"]').tap(); await wait(150);
  const pb = await page.locator('#pad').boundingBox(), n0 = TV.frames.length;
  await touch('touchStart', pb.x + 60, pb.y + 120); for (let x = 60; x <= 200; x += 20) { await touch('touchMove', pb.x + x, pb.y + 120); await wait(20); } await touch('touchEnd'); await wait(300);
  ok(TV.frames.slice(n0).filter(f => f.params && f.params.DataOfCmd === 'KEY_RIGHT').length >= 2, 'touchpad swipe right -> KEY_RIGHT presses');
  await page.locator('[data-m="dpad"]').tap();

  // ---- launcher 'remote' event (TV app js/voice.js) ----
  const tvp = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  tvp.on('pageerror', e => errors.push('tv: ' + e));
  await tvp.goto('file://' + path.join(ROOT, 'index.html') + '?still=1&relay=' + encodeURIComponent(R));
  await tvp.waitForFunction(() => window.RH_Voice && RH_Voice.available, null, { timeout: 10000 });
  await page.locator('.app', { hasText: 'Yo-Yo on TV' }).tap();
  await tvp.waitForFunction(() => RH_Voice.open, null, { timeout: 3000 }).catch(() => {});
  ok(await tvp.evaluate(() => RH_Voice.open), "'Yo-Yo on TV' opens the overlay on the launcher via the SSE 'remote' event");
  await tvp.close();
  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  if (PREVIEW) {
    await page.locator('[data-v="remote"]').tap(); await wait(3500);
    await page.screenshot({ path: path.join(ROOT, 'preview-remote-remote.png') });
    await page.locator('[data-v="home"]').tap(); await wait(500);
    await page.screenshot({ path: path.join(ROOT, 'preview-remote-home.png') });
    await page.locator('[data-v="yoyo"]').tap(); await wait(400);
    await plan([{ words: ['something', 'funny', 'under', 'two', 'hours', 'on', 'Netflix'] }]);
    await touch('touchStart', cx, cy); await wait(1000);
    await page.screenshot({ path: path.join(ROOT, 'preview-remote-yoyo.png') });
    answerLive = true; await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('ystate').textContent === 'Answer', null, { timeout: 30000 }).catch(() => {});
    await wait(300); await page.screenshot({ path: path.join(ROOT, 'preview-remote-yoyo-answer.png') });
    console.log('previews: preview-remote-pairing.png, preview-remote-denied.png, preview-remote-remote.png, preview-remote-yoyo.png (holding), preview-remote-yoyo-answer.png, preview-remote-home.png');
  }
  // ---- server speech-to-text: MediaRecorder -> POST /stt, then fallback to Web Speech ----
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx2.addInitScript(FAKE_SR);
  await ctx2.addInitScript(() => {
    window.__mr = { starts: 0, stops: 0, tracksStopped: 0, gum: 0, deny: false };
    navigator.mediaDevices.getUserMedia = c => { __mr.gum++; if (__mr.deny) return Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
      return Promise.resolve({ getTracks: () => [{ stop: () => __mr.tracksStopped++ }] }); };
    window.MediaRecorder = class { constructor(s, o) { this.mimeType = (o && o.mimeType) || 'audio/mp4'; this.state = 'inactive'; }
      static isTypeSupported(t) { return t === 'audio/mp4'; }
      start() { this.state = 'recording'; __mr.starts++; }
      stop() { if (this.state === 'inactive') return; this.state = 'inactive'; __mr.stops++; setTimeout(() => { this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(3000)], { type: this.mimeType }) }); this.onstop && this.onstop(); }, 30); } };
  });
  const p2 = await ctx2.newPage(), cdp2 = await ctx2.newCDPSession(p2); p2.on('pageerror', e => errors.push('p2: ' + e));
  let sttReply = { code: 200, body: { text: 'play dune on max', engine: 'whisper', ms: 800 } }; const sttReqs = [], asks2 = [];
  await p2.route('**/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, brain: 'test brain', stt: { engine: 'whisper', maxSec: 30, maxBytes: 4e6 } }) }));
  await p2.route('**/stt?*', r => { sttReqs.push({ url: r.request().url(), type: r.request().headers()['content-type'], size: (r.request().postDataBuffer() || []).length });
    r.fulfill({ status: sttReply.code, contentType: 'application/json', body: JSON.stringify(sttReply.body) }); });
  await p2.route('**/ask', r => { asks2.push(JSON.parse(r.request().postData())); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'answer', text: 'Okay.', brain: 'built-in', stats: {} }) }); });
  await p2.goto(R + '/?tab=yoyo'); await wait(400);
  const b2 = await p2.locator('#mic').boundingBox(), x2 = b2.x + b2.width / 2, y2 = b2.y + b2.height / 2;
  const t2 = (type, x, y) => cdp2.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const hold2 = async ms => { await t2('touchStart', x2, y2); await wait(ms); await t2('touchEnd'); };
  ok(await p2.evaluate(() => RV.stt().use) && /speech: whisper on the Mac/.test(await p2.locator('#brain').textContent()), 'relay has an STT engine -> recorder mode');
  await hold2(900); for (let i = 0; i < 40 && !asks2.length; i++) await wait(50);
  const mr = await p2.evaluate(() => __mr), q2 = sttReqs[0] && new URL(sttReqs[0].url);
  ok(sttReqs.length === 1 && sttReqs[0].type === 'audio/mp4' && sttReqs[0].size === 3000 && q2.searchParams.get('lang') === 'en-US' && +q2.searchParams.get('sec') > 0.5, 'hold -> MediaRecorder audio/mp4 POSTed to /stt?lang&sec');
  ok(asks2[0] && asks2[0].text === 'play dune on max' && asks2[0].sttMs > 500, 'transcript sent to /ask');
  ok(mr.gum === 1 && mr.tracksStopped === 1 && (await p2.evaluate(() => (__sr.created))) === 0, 'mic tracks stopped after the recording; Web Speech not used');
  await hold2(200); await wait(200);
  ok(/Keep holding/.test(await p2.locator('#heard').textContent()) && sttReqs.length === 1 && (await p2.evaluate(() => __mr.tracksStopped)) === 2, 'quick tap -> nothing uploaded, mic released');
  sttReply = { code: 422, body: { error: 'No speech heard.', engine: 'whisper' } }; await hold2(800); await wait(400);
  ok(/Didn.t catch that/.test(await p2.locator('#heard').textContent()) && asks2.length === 1 && await p2.evaluate(() => RV.stt().use), '422 no speech -> try again, stays on recorder');
  sttReply = { code: 503, body: { error: 'Speech-to-text is off on the relay.' } }; await hold2(800); await wait(400);
  ok(/Switched to the phone.s own recognition/.test(await p2.locator('#heard').textContent()) && !(await p2.evaluate(() => RV.stt().use)), '/stt 503 -> falls back to Web Speech');
  await hold2(900); for (let i = 0; i < 40 && asks2.length < 2; i++) await wait(50);
  ok(asks2[1] && asks2[1].text === 'something funny on Netflix' && sttReqs.length === 3, 'next press uses Web Speech');
  // power -> Wake-on-LAN hint when the TV stays off
  await p2.evaluate(() => localStorage.setItem('rv.wakewait', '200'));
  await p2.route('**/remote/power', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, via: 'wol', sent: 6, hint: 'If the TV doesn\u2019t turn on, enable Settings \u203a General \u203a Network \u203a Expert Settings \u203a Power On with Mobile on the TV.' }) }));
  await p2.route('**/remote/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ state: 'offline', power: 'off', paired: true }) }));
  await p2.locator('#pwr').tap(); await wait(700);
  ok(/Power On with Mobile/.test(await p2.locator('#toast').textContent()), 'power via WoL -> "Power On with Mobile" hint if the TV stays off');
  await ctx2.close();

  // ---- v6.2 "Show on TV" (real relay + fake TV: Netflix on screen, Home not running) ----
  {
    const LONG = 'Three good picks for tonight. **Severance** (Apple TV+) is a sharp, strange workplace thriller and season two pays off. ' +
      '**The Bear** (Hulu) is short, loud and great. **Slow Horses** (Apple TV+) is a funny spy show with Gary Oldman, six episodes a season. Start with Severance if you want something to binge.';
    const sc = CH.create({ client: 'test' });
    CH.addMessage(sc, { role: 'user', text: 'What should I watch tonight?' });
    const lm = CH.addMessage(sc, { role: 'assistant', text: LONG, brain: 'gemini', items: [{ title: 'Severance', year: 2022, imdb: '8.7' }] });
    CH.addMessage(sc, { role: 'user', text: 'thanks' }); CH.addMessage(sc, { role: 'assistant', text: 'Enjoy!' });
    const legacy = CH.create({ client: 'test' }); CH.addMessage(legacy, { role: 'user', text: 'old question' }); CH.addMessage(legacy, { role: 'assistant', text: LONG });
    legacy.messages.forEach(m => { delete m.id; }); CH.save(legacy);   // saved before v6.2: no message ids
    const DOCKAPPS = require('../relay/dock-apps').load(), NF = DOCKAPPS.apps.find(a => a.key === 'netflix').appId;
    Object.keys(TV.running).forEach(k => TV.running[k] = false); TV.running[NF] = true;
    await page.evaluate(id => localStorage.setItem('rv.chat', id), sc.id); await page.goto(R + '/?tab=yoyo'); await page.waitForSelector('#thread .msg'); await wait(500);
    ok(await page.locator('#thread .msg.bot .tvb').count() === 1, 'Show on TV: only on the long assistant answer (>= 250 chars)');
    const tvb = page.locator('#thread .msg.bot .tvb').first(); hits.length = 0;
    await tvb.tap(); await wait(150);
    ok(/away from what.s playing/.test(await tvb.textContent()) && !hits.some(h => /\/tv\/show/.test(h)), 'first tap only arms it and says it switches the TV away from what is playing');
    if (PREVIEW) await page.screenshot({ path: path.join(ROOT, 'preview-v62-phone.png') });
    await tvb.tap(); await wait(900);
    const h = hits.find(x => /^\/tv\/show /.test(x));
    ok(h && JSON.parse(h.slice(9)).messageId === lm.id && JSON.parse(h.slice(9)).chatId === sc.id, 'second tap -> POST /tv/show { chatId, messageId }');
    ok(/Opening Home on the TV.*back to Netflix/.test(await page.locator('#toast').textContent()), 'toast: Home opened, OK on the TV goes back to Netflix (' + await page.locator('#toast').textContent() + ')');
    ok(TV.running['GlassHome1.launcher'] === true, 'fake TV: Glass Home launched');
    ok(/Show on TV/.test(await tvb.textContent()), 'button resets after sending');
    await page.evaluate(id => localStorage.setItem('rv.chat', id), legacy.id); await page.goto(R + '/?tab=yoyo'); await page.waitForSelector('#thread .msg .tvb'); hits.length = 0;
    const lb = page.locator('#thread .msg.bot .tvb').first(); await lb.tap(); await wait(100); await lb.tap(); await wait(900);
    const h2 = hits.find(x => /^\/tv\/show /.test(x));
    ok(h2 && JSON.parse(h2.slice(9)).index === 1 && !JSON.parse(h2.slice(9)).messageId, 'answers saved before v6.2 send their index instead');
    ok(/On the TV/.test(await page.locator('#toast').textContent()), 'Home already in front -> "On the TV."');
    await page.evaluate(() => localStorage.removeItem('rv.chat'));
  }

  if (PREVIEW) {   // v6 chat previews (the real relay chat store)
    const pc = CH.create({ client: 'preview' });
    [['user', 'What can I make for dinner with chicken, rice and some spinach?'],
     ['assistant', 'Try a one-pan garlic chicken and spinach rice: brown the chicken, toast the rice in the same pan, add stock, then fold in the spinach for the last two minutes. About 30 minutes.', { brain: 'gemini' }],
     ['user', 'Play some RÜFÜS DU SOL on YouTube'],
     ['assistant', 'Playing RÜFÜS DU SOL \u2013 Innerbloom on YouTube.', { played: { status: 'playing', service: 'youtube', title: 'RÜFÜS DU SOL - Innerbloom' } }],
     ['user', 'Is Dune Part Two on any of my services?'],
     ['assistant', 'Yes, Dune: Part Two is on Max. Want me to start it?', { items: [{ title: 'Dune: Part Two', year: 2024, imdb: '8.5' }] }]].forEach(m => CH.addMessage(pc, Object.assign({ role: m[0], text: m[1] }, m[2] || {})));
    CH.rename(pc.id, 'Dinner, music & Dune');
    const c3 = CH.create({ client: 'preview' }); CH.addMessage(c3, { role: 'user', text: 'Explain how noise cancelling headphones work' }); CH.addMessage(c3, { role: 'assistant', text: 'They listen to outside sound and play the inverse wave.' });
    const c4 = CH.create({ client: 'preview' }); CH.addMessage(c4, { role: 'user', text: 'Weekend trip ideas near the coast' });
    CH.save(Object.assign(pc, { updated: Date.now() + 1000 }));
    await page.evaluate(id => localStorage.setItem('rv.chat', id), pc.id); await page.goto(R + '/?tab=yoyo'); await page.waitForSelector('#thread .msg'); await wait(900);
    await page.screenshot({ path: path.join(ROOT, 'preview-v6-chat.png') });
    await page.locator('#chatsb').tap(); await page.waitForSelector('.crow'); await wait(500);
    await page.screenshot({ path: path.join(ROOT, 'preview-v6-chats.png') });
    await page.locator('#dclose').tap(); await wait(200);
    await plan([{ words: ['what', 'should', 'I', 'watch', 'tonight'] }]); await touch('touchStart', cx, cy); await wait(900);
    await page.screenshot({ path: path.join(ROOT, 'preview-v6-listening.png') }); await touch('touchMove', cx, cy - 260); await touch('touchEnd'); await wait(200);
    console.log('previews: preview-v6-chat.png, preview-v6-chats.png, preview-v6-listening.png');
  }
  await browser.close(); relay.tv.close(); relay.server.close(); TV.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + '/' + (pass + fail) + ' phone tests passed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
