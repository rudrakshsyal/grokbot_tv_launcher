// v6.3 regression: key path does no style/layout reads, clock paints before boot, focus survives the
// corner card and Show on TV panel, a relay blip does not wipe a finished answer, phone bubbles are not
// backdrop-blurred, speech-to-text comes back after the relay, and a double tap launches once.
// Headless Chrome + a local fake relay. No TV, no API keys, no network.
// usage: node tools/test-polish.js
const path = require('path'), http = require('http'), fs = require('fs'), os = require('os');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
const root = path.resolve(__dirname, '..');
let fails = 0;
const check = (label, ok, extra) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined && !ok ? '  ' + JSON.stringify(extra) : '')); };

function servePhone() {
  const phone = fs.readFileSync(path.join(root, 'relay/phone.html'));
  const state = { launches: 0, statusHits: 0, failStatus: 0 };
  const srv = http.createServer((q, s) => {
    const u = q.url.split('?')[0];
    const json = (code, o) => { s.writeHead(code, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (q.method === 'GET' && (u === '/' || u === '/index.html')) { s.writeHead(200, { 'Content-Type': 'text/html' }); return s.end(phone); }
    if (q.method === 'GET' && u === '/remote/status') return json(200, { state: 'connected', power: 'on', paired: true });
    if (q.method === 'GET' && u === '/remote/apps') return json(200, { launcher: { key: 'launcher', name: 'Home', appId: 'GlassHome1.launcher', color: '#8fa2ff' }, apps: [{ key: 'netflix', name: 'Netflix', color: '#e50914', appId: '3201907018807' }] });
    if (q.method === 'GET' && u === '/status') {
      state.statusHits++;
      if (state.failStatus > 0) { state.failStatus--; return json(503, { error: 'down' }); }
      return json(200, { ok: true, brain: 'built-in parser', stt: { engine: 'whisper', maxSec: 30 } });
    }
    if (q.method === 'POST' && u === '/remote/launch') {
      state.launches++;
      return setTimeout(() => json(200, { ok: true, via: 'rest', app: 'netflix' }), 250);
    }
    if (q.method === 'POST') return json(200, { ok: true, text: 'ok', brain: 'test' });
    json(404, { error: 'no' });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, state, port: srv.address().port })));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-polish-'));
  for (const k of ['DATA_DIR', 'CHATS_DIR', 'METRICS_DIR', 'LOG_DIR']) process.env[k] = path.join(tmp, k.toLowerCase());
  process.env.MOCK = '1'; process.env.LOG = '0'; process.env.TV_POLL = '0'; process.env.TV_AUTOCONNECT = '0';
  const relay = require(path.join(root, 'relay/server'));
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  const R = 'http://127.0.0.1:' + relay.server.address().port;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--force-color-profile=srgb'] });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto('file://' + path.join(root, 'index.html') + '?still=1&discover=0&idle=0&relay=' + encodeURIComponent(R));
  await page.waitForFunction(() => window.RH_Voice && RH_Voice.available, null, { timeout: 8000 });

  const marks = await page.evaluate(() => {
    const c = performance.getEntriesByName('rh-clock')[0], b = performance.getEntriesByName('rh-boot')[0];
    return { clock: c && c.startTime, boot: b && b.startTime, text: document.getElementById('ambTime').textContent };
  });
  check('clock mark is before launcher boot', marks.clock > 0 && marks.boot > marks.clock, marks);
  check('ambient clock is filled', /\d:\d\d/.test(marks.text), marks.text);
  console.log('     clock mark ' + marks.clock.toFixed(1) + ' ms, boot mark ' + marks.boot.toFixed(1) + ' ms (headless navigation timing)');

  const keys = await page.evaluate(() => {
    let styles = 0, rects = 0;
    const os = window.getComputedStyle; window.getComputedStyle = function () { styles++; return os.apply(this, arguments); };
    const or = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function () { rects++; return or.apply(this, arguments); };
    const send = c => { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => c }); document.dispatchEvent(e); };
    styles = 0; rects = 0;
    const t0 = performance.now(); send(39); const revealMs = performance.now() - t0;
    const reveal = { styles, rects, dock: document.body.classList.contains('dock-on'), ms: revealMs };
    for (let i = 0; i < 20; i++) send(39);
    styles = 0; rects = 0;
    const t1 = performance.now(); for (let i = 0; i < 30; i++) send(39); const edgeMs = performance.now() - t1;
    return { reveal, edge: { styles, rects, ms: edgeMs }, focus: RH_debug.focus.i };
  });
  check('revealing the dock does not measure layout on that key', keys.reveal.dock && keys.reveal.rects === 0 && keys.reveal.styles === 0, keys.reveal);
  check('30 presses past the last tile do not read computed style', keys.edge.styles === 0 && keys.edge.rects === 0, keys.edge);
  console.log('     reveal key ' + keys.reveal.ms.toFixed(2) + ' ms; 30 edge keys ' + keys.edge.ms.toFixed(2) + ' ms (headless, synchronous handlers)');
  await page.waitForTimeout(50);
  const geom = await page.evaluate(() => {
    const tile = document.querySelector('.tile-lg .tile-body');
    const cs = getComputedStyle(tile), lab = getComputedStyle(document.querySelector('.tile-label'));
    const dock = getComputedStyle(document.querySelector('.dock'));
    const cx = [].map.call(document.querySelectorAll('.row-dock .tile'), t => t.__cx);
    const blur = getComputedStyle(document.querySelector('.dock-bg')).webkitBackdropFilter || getComputedStyle(document.querySelector('.dock-bg')).backdropFilter || '';
    return { w: cs.width, h: cs.height, weight: lab.fontWeight, pad: dock.padding, cx, blur };
  });
  check('dock tiles are the thin size', geom.w === '148px' && geom.h === '72px', geom);
  check('dock labels are weight 400', geom.weight === '400' || geom.weight === 'normal', geom.weight);
  check('dock padding is the tighter bar', geom.pad === '8px 16px' || geom.pad === '8px 16px 8px 16px', geom.pad);
  check('tile centres were cached off the key path', geom.cx.length === 8 && geom.cx.every(n => typeof n === 'number' && n > 0), geom.cx);
  check('baked dock glass is not a live backdrop blur', !/blur/.test(geom.blur), geom.blur);

  const send = code => page.evaluate(c => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'keyCode', { get: () => c }); document.dispatchEvent(e); }, code);
  await send(37); // back toward the start, dock is open so this moves
  await page.evaluate(() => { RH_debug.setFocus(RH_debug.rowIndex('apps'), 1, true); });
  const focusOf = () => page.evaluate(() => ({ i: RH_debug.focus.i, kind: RH_debug.rows[RH_debug.focus.r].kind, card: !!(window.RH_VoiceCard && RH_VoiceCard.visible), panel: !!(window.RH_VoiceCard && RH_VoiceCard.panelOpen), open: RH_Voice.open, state: RH_VoiceCard && RH_VoiceCard.state }));
  await page.evaluate(() => { const s = 42;
    RH_Voice._event({ type: 'start', session: s, query: 'What is on tonight?', ts: Date.now() });
    RH_Voice._event({ type: 'answer', session: s, text: 'A short answer that should sit in the corner and leave the highlight where it was.', items: [], ts: Date.now() });
  });
  await page.waitForFunction(() => RH_VoiceCard.state === 'done', null, { timeout: 3000 });
  let f = await focusOf();
  check('corner card does not steal focus', f.card && !f.open && f.kind === 'apps' && f.i === 1, f);
  await send(8);
  f = await focusOf();
  check('Back dismisses the card and leaves focus', !f.card && f.kind === 'apps' && f.i === 1, f);
  await page.evaluate(() => RH_VoiceCard.show({ type: 'tv-show', id: 'polish1', question: 'A long one?', text: 'Line\n\n'.repeat(30) + 'End.', prev: { key: 'netflix', name: 'Netflix' }, ts: Date.now() }));
  await page.waitForTimeout(50);
  f = await focusOf();
  check('Show on TV panel opens without moving focus', f.panel && f.i === 1, f);
  await send(8);
  f = await focusOf();
  check('Back closes the panel and restores the same tile', !f.panel && !f.open && f.i === 1, f);

  await page.evaluate(() => { const s = 77;
    RH_VoiceCard._linkGrace(200);
    RH_Voice._event({ type: 'start', session: s, query: 'Still there?', ts: Date.now() });
    RH_Voice.es.onerror();
  });
  f = await focusOf();
  check('a dropped event stream shows Reconnecting and keeps focus', f.card && f.state === 'reconnecting' && f.i === 1, f);
  await page.evaluate(() => RH_Voice.es.onopen());
  f = await focusOf();
  check('reconnect restores the in-progress card', f.state === 'thinking' && f.i === 1, f);
  await page.evaluate(() => {
    RH_Voice._event({ type: 'answer', session: 77, text: 'Finished.', items: [], ts: Date.now() });
  });
  await page.waitForFunction(() => RH_VoiceCard.state === 'done');
  await page.evaluate(() => RH_Voice.es.onerror());
  await page.waitForTimeout(350);
  f = await focusOf();
  check('a finished card stays after another blip', f.card && f.state === 'done', f);
  await page.evaluate(() => RH_Voice.es.onopen());   // clear the grace timer before the next case

  await send(86); // v: open the full panel
  await page.waitForTimeout(30);
  check('Play stand-in opens the full Yo-Yo panel', (await focusOf()).open);
  await page.evaluate(() => {
    RH_VoiceCard._linkGrace(8000);
    RH_Voice._event({ type: 'listening', ts: Date.now() });   // a live session, not a finished answer
    RH_Voice._linkGrace(200); RH_Voice.es.onerror();
  });
  check('overlay stays up on the error event itself', (await focusOf()).open);
  await page.waitForTimeout(400);
  check('overlay closes only after the grace if the relay stays down', !(await focusOf()).open);
  await page.evaluate(() => RH_Voice.es.onopen());
  await send(86);
  await page.evaluate(() => {
    RH_Voice._event({ type: 'start', session: 100, query: 'q', ts: Date.now() });
    RH_Voice._event({ type: 'answer', session: 100, text: 'Done answer stays.', items: [], brain: 'test', stats: null, ts: Date.now() });
    RH_Voice._linkGrace(200); RH_Voice.es.onerror();
  });
  await page.waitForTimeout(400);
  f = await focusOf();
  check('a finished full panel is not dismissed by a blip', f.open && !f.card, f);
  check('no page errors', errs.length === 0, errs);

  // phone
  const ph = await servePhone();
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phoneCtx.addInitScript(() => {
    if (!window.MediaRecorder) window.MediaRecorder = function () {};
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: function () { return Promise.reject(new Error('no')); } } });
  });
  const phone = await phoneCtx.newPage();
  const perr = []; phone.on('pageerror', e => perr.push(String(e)));
  await phone.goto('http://127.0.0.1:' + ph.port + '/?tab=yoyo');
  await phone.waitForFunction(() => /whisper/.test(document.getElementById('brain').textContent), null, { timeout: 4000 });
  check('phone loads speech-to-text from /status', /whisper/.test(await phone.textContent('#brain')));
  const blur = await phone.evaluate(() => {
    const b = getComputedStyle(document.querySelector('.msg') || document.body);
    document.getElementById('thread').textContent = '';
    const d = document.createElement('div'); d.className = 'msg bot'; d.textContent = 'Hello';
    document.getElementById('thread').appendChild(d);
    const cs = getComputedStyle(d);
    return (cs.backdropFilter || cs.webkitBackdropFilter || 'none');
  });
  check('chat bubbles do not use backdrop-filter', blur === 'none' || blur === '', blur);
  await phone.evaluate(() => RV.breakStt());
  check('a hard STT failure stays off while the relay never dropped', (await phone.evaluate(() => RV.stt())).broken === true && (await phone.evaluate(() => RV.stt().use)) === false);
  await phone.evaluate(() => RV.refreshStatus());
  check('refresh while the relay stayed up does not clear that fallback', (await phone.evaluate(() => RV.stt().use)) === false);
  ph.state.failStatus = 1;
  await phone.evaluate(() => RV.markRelayDown());
  await phone.evaluate(() => RV.refreshStatus());
  check('a failed status while marked down keeps the fallback', (await phone.evaluate(() => RV.stt().use)) === false);
  await phone.evaluate(() => RV.refreshStatus());
  await phone.waitForFunction(() => RV.stt().use);
  check('after the relay is back, the Mac transcriber is used again', (await phone.evaluate(() => RV.stt())).engine === 'whisper' && (await phone.evaluate(() => RV.stt().use)) === true);

  await phone.goto('http://127.0.0.1:' + ph.port + '/?tab=remote');
  await phone.waitForSelector('.app');
  const netflix = phone.locator('.app', { hasText: 'Netflix' });
  await netflix.click(); await netflix.click();
  await phone.waitForTimeout(400);
  check('double tap launches once', ph.state.launches === 1, ph.state.launches);
  check('phone page has no errors', perr.length === 0, perr);

  await browser.close();
  relay.server.close(); try { relay.tv.close(); } catch (e) {}
  ph.srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? fails + ' FAILED' : 'polish: all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
