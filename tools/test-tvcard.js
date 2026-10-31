// v6.2 corner card + "Show on TV" panel (js/tvcard.js), headless Chrome. Relay in-process, MOCK mode (no Gemini, no TV).
// usage: node tools/test-tvcard.js [root]
const path = require('path'), http = require('http'), assert = require('assert');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
{ const os = require('os'), fs = require('fs'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-voice-'));   // never write test chats into relay/data
  for (const k of ['DATA_DIR', 'CHATS_DIR', 'METRICS_DIR', 'LOG_DIR']) process.env[k] = path.join(tmp, k.toLowerCase()); }
process.env.MOCK = '1'; process.env.MOCK_SLOW = '1'; process.env.LOG = '0';
const relay = require('../relay/server');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } }
const LONG = 'Here is the full rundown.\n\n**Severance** is a sharp workplace thriller on Apple TV+ with a second season that pays off.\n' +
  '- **The Bear** (FX on Hulu): kitchen chaos, great acting, short episodes.\n- **Shogun** (Hulu): big, patient historical drama.\n- **Slow Horses** (Apple TV+): funny spy show with Gary Oldman.\n\n' +
  Array.from({ length: 12 }, (_, i) => 'Paragraph ' + (i + 1) + ': more detail about what to watch tonight, ratings, runtimes and where each title streams.').join('\n\n');
relay.server.listen(0, '127.0.0.1', async () => {
  const R = 'http://127.0.0.1:' + relay.server.address().port;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
  const open = async (q) => { const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); const errs = [];
    p.on('pageerror', e => errs.push(String(e))); p.errs = errs; p.tv = [];
    await p.route(R + '/tv/**', (rt) => { const rq = rt.request(); p.tv.push({ m: rq.method(), u: rq.url().slice(R.length), ct: rq.headers()['content-type'] || '', b: rq.postData() });
      rt.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: rq.url().indexOf('/tv/pending') > 0 ? '{"ok":true,"pending":null}' : '{"ok":true}' }); });
    await p.goto('file://' + path.join(root, 'index.html') + '?still=1&discover=0&' + q); await p.waitForTimeout(1500); return p; };
  const ask = () => new Promise(r => { const q = http.request(R + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', r); }); q.end('{"text":"x"}'); });
  const st = (p) => p.evaluate(() => ({ on: RH_VoiceCard.visible, state: RH_VoiceCard.state, open: RH_Voice.open, cls: document.getElementById('yoyoCard') ? document.getElementById('yoyoCard').className : '' }));

  const p = await open('relay=' + encodeURIComponent(R));
  await p.waitForFunction(() => RH_Voice.available, null, { timeout: 5000 });
  await t('phone /ask shows the corner card (not the full overlay); the home rows stay visible', async () => {
    const f0 = await p.evaluate(() => JSON.stringify(RH_debug.focus));
    await ask();
    await p.waitForFunction(() => RH_VoiceCard.state === 'done', null, { timeout: 15000 });
    const s = await st(p);
    assert.ok(s.on && !s.open, JSON.stringify(s));
    assert.strictEqual(await p.evaluate(() => document.body.classList.contains('voice-on')), false);
    assert.ok(await p.$eval('#ycQ', e => e.textContent.length > 2));
    assert.ok(await p.$eval('#ycA', e => e.textContent.length > 10));
    assert.strictEqual(await p.evaluate(() => JSON.stringify(RH_debug.focus)), f0);
    assert.strictEqual(await p.evaluate(() => RH_Voice.state), 'done', 'the overlay state still follows in the background');
  });
  await t('card geometry: bottom-right, at most ~30% of the screen width, baked glass inside', async () => {
    const b = await p.$eval('#yoyoCard', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, w: r.width, h: r.height, bk: !!e.querySelector('.bk') }; });
    assert.ok(b.w <= 1920 * 0.3 && b.r > 1800 && b.b > 960 && b.h < 520 && b.bk, JSON.stringify(b));
  });
  await t('arrows / OK still drive the launcher while the card is up', async () => {
    await p.keyboard.press('ArrowUp'); await p.waitForTimeout(250);
    await p.keyboard.press('ArrowDown'); await p.waitForTimeout(250);
    assert.ok((await st(p)).on, 'card stays'); assert.strictEqual(await p.evaluate(() => RH_Voice.open), false);
  });
  await t('Back dismisses the card (and only the card)', async () => {
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);
    assert.strictEqual((await st(p)).on, false);
  });
  await t('states: listening -> thinking (step label) -> answering -> done; fades after ~8 s', async () => {
    const s = 5000;
    await p.evaluate(s => { RH_VoiceCard._reset(); RH_Voice._event({ type: 'listening', ts: Date.now() }); }, s);
    assert.strictEqual((await st(p)).state, 'listening');
    await p.evaluate(s => RH_Voice._event({ type: 'transcript', text: 'what should I wa', final: false, ts: Date.now() }), s);
    assert.ok(/what should I wa/.test(await p.$eval('#ycQ', e => e.textContent)));
    await p.evaluate(s => { RH_Voice._event({ type: 'start', session: s, query: 'what should I watch tonight', ts: Date.now() });
      RH_Voice._event({ type: 'step', session: s, id: 'a', phase: 'start', label: 'Checking Trakt', ts: Date.now() }); }, s);
    assert.strictEqual((await st(p)).state, 'thinking');
    assert.ok(/Checking Trakt/.test(await p.$eval('#ycA', e => e.textContent)));
    const t0 = Date.now();
    await p.evaluate(s => RH_Voice._event({ type: 'answer', session: s, text: 'Try **Severance** tonight.', items: [], ts: Date.now() }), s);
    assert.strictEqual((await st(p)).state, 'answering');
    await p.waitForFunction(() => RH_VoiceCard.state === 'done', null, { timeout: 3000 });
    assert.strictEqual(await p.$eval('#ycA', e => e.textContent), 'Try Severance tonight.');
    await p.waitForTimeout(6000); assert.ok((await st(p)).on, 'still up after 6 s');
    await p.waitForFunction(() => !RH_VoiceCard.visible, null, { timeout: 4500 });
    const el = Date.now() - t0; assert.ok(el > 7500 && el < 11500, 'faded after ' + el + ' ms');
  });
  await t('long answers stay longer (and are clamped in the card)', async () => {
    await p.evaluate(() => { RH_Voice._event({ type: 'start', session: 5001, query: 'long one', ts: Date.now() });
    });
    await p.evaluate(t => RH_Voice._event({ type: 'answer', session: 5001, text: t, ts: Date.now() }), LONG);
    await p.waitForFunction(() => RH_VoiceCard.state === 'done', null, { timeout: 3000 });
    const h = await p.$eval('#ycA', e => e.getBoundingClientRect().height); assert.ok(h < 210, 'clamped: ' + h);
    assert.ok(/Show on TV/.test(await p.$eval('#ycF', e => e.textContent)), 'hint to the phone button');
    await p.waitForTimeout(9000); assert.ok((await st(p)).on, 'long answer still up after 9 s');
    await p.keyboard.press('Escape');
  });
  await t('stale events (buffered while suspended) are ignored', async () => {
    await p.evaluate(() => { RH_VoiceCard._reset(); RH_Voice._event({ type: 'listening', ts: Date.now() }); });
    await p.keyboard.press('Escape');
    await p.evaluate(() => RH_Voice._event({ type: 'start', session: 5002, query: 'old', ts: Date.now() - 60000 }));
    assert.strictEqual((await st(p)).on, false);
  });
  await t('launcher hidden: nothing happens', async () => {
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); RH_Voice._event({ type: 'start', session: 5003, query: 'q', ts: Date.now() }); });
    assert.strictEqual((await st(p)).on, false);
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
  });
  await t('Play/Pause while the card is up opens the full Yo-Yo view (card hides)', async () => {
    await p.waitForTimeout(800);
    await p.evaluate(() => { RH_VoiceCard._reset(); RH_Voice._event({ type: 'start', session: 5004, query: 'q', ts: Date.now() }); });
    assert.ok((await st(p)).on);
    await p.keyboard.press('v'); await p.waitForTimeout(200);
    const s = await st(p); assert.ok(!s.on && s.open, JSON.stringify(s));
    await p.evaluate(() => RH_Voice._event({ type: 'answer', session: 5004, text: 'ok', ts: Date.now() }));
    assert.ok((await st(p)).open && !(await st(p)).on, 'overlay keeps updating, no card');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  });

  const SHOW = { type: 'tv-show', id: 's1', chatId: 'c1', messageId: 'm1', chatTitle: 'Tonight', question: 'What should I watch tonight?', text: LONG,
    items: [{ title: 'Severance', year: 2022, imdb: 8.7, platformName: 'Apple TV+' }], prev: { key: 'netflix', name: 'Netflix' } };
  await t('tv-show event opens the centered scrollable panel and acks it (text/plain, no preflight)', async () => {
    p.tv.length = 0;
    await p.evaluate(ev => RH_Voice._event(ev), SHOW); await p.waitForTimeout(500);
    const ps = await p.evaluate(() => RH_VoiceCard._panel());
    const dbg = await p.evaluate(() => [document.getElementById('ypBody').scrollHeight, document.getElementById('ypBody').offsetHeight, document.getElementById('ypView').clientHeight, document.getElementById('ypBody').innerHTML.length]);
    assert.ok(ps.on && ps.id === 's1' && ps.max > 100, JSON.stringify(ps) + JSON.stringify(dbg));
    const b = await p.$eval('#ypBox', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
    assert.ok(Math.abs((b.l + b.r) / 2 - 960) < 4 && b.t > 60 && b.b < 1020, JSON.stringify(b));
    assert.ok(/Back to Netflix/.test(await p.$eval('#ypBack', e => e.textContent)));
    assert.ok(await p.$eval('#ypBody', e => e.querySelectorAll('li').length === 3 && e.querySelectorAll('b').length >= 3));
    const a = p.tv.find(x => x.u === '/tv/shown'); assert.ok(a && /text\/plain/.test(a.ct) && JSON.parse(a.b).id === 's1', JSON.stringify(p.tv));
  });
  await t('Up/Down scroll the panel and clamp; the home focus does not move', async () => {
    const f0 = await p.evaluate(() => JSON.stringify(RH_debug.focus));
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
    assert.strictEqual((await p.evaluate(() => RH_VoiceCard._panel())).y, 400);
    for (let i = 0; i < 40; i++) await p.keyboard.press('ArrowDown');
    const ps = await p.evaluate(() => RH_VoiceCard._panel()); assert.strictEqual(ps.y, ps.max);
    for (let i = 0; i < 40; i++) await p.keyboard.press('ArrowUp');
    assert.strictEqual((await p.evaluate(() => RH_VoiceCard._panel())).y, 0);
    await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowRight');
    assert.strictEqual(await p.evaluate(() => JSON.stringify(RH_debug.focus)), f0);
  });
  await t('phone questions while the panel is up do not pop the card', async () => {
    await p.evaluate(() => RH_Voice._event({ type: 'start', session: 5005, query: 'q', ts: Date.now() }));
    assert.strictEqual((await st(p)).on, false);
  });
  await t('Back closes the panel; the same show id is not shown twice', async () => {
    await p.keyboard.press('Escape'); await p.waitForTimeout(100);
    assert.strictEqual((await p.evaluate(() => RH_VoiceCard._panel())).on, false);
    await p.evaluate(ev => RH_Voice._event(Object.assign({ replay: true }, ev)), SHOW);
    assert.strictEqual((await p.evaluate(() => RH_VoiceCard._panel())).on, false);
  });
  await t('OK on "Back to Netflix" asks the relay to relaunch it (POST /tv/back)', async () => {
    p.tv.length = 0;
    await p.evaluate(ev => RH_Voice._event(Object.assign({}, ev, { id: 's2' })), SHOW); await p.waitForTimeout(300);
    await p.evaluate(() => { window.__launched = []; RH_Home.launchApp = k => window.__launched.push(k); });
    await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    const b = p.tv.find(x => x.u === '/tv/back'); assert.ok(b && JSON.parse(b.b).id === 's2' && /text\/plain/.test(b.ct), JSON.stringify(p.tv));
    assert.deepStrictEqual(await p.evaluate(() => window.__launched), [], 'relay did it: no local launch');
    assert.strictEqual((await p.evaluate(() => RH_VoiceCard._panel())).on, false);
  });
  await t('no previous app: no "Back to" button, OK does nothing', async () => {
    p.tv.length = 0;
    await p.evaluate(ev => RH_Voice._event(Object.assign({}, ev, { id: 's3', prev: null, text: 'Short answer.' })), SHOW); await p.waitForTimeout(300);
    assert.strictEqual(await p.$eval('#ypBack', e => getComputedStyle(e).display), 'none');
    assert.ok(/Back/.test(await p.$eval('#ypHelp', e => e.textContent)) && !/scroll/.test(await p.$eval('#ypHelp', e => e.textContent)));
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    assert.ok((await p.evaluate(() => RH_VoiceCard._panel())).on); assert.ok(!p.tv.find(x => x.u === '/tv/back'));
    await p.keyboard.press('Escape');
  });
  await t('tv-show while hidden waits and opens on resume', async () => {
    await p.evaluate(ev => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); RH_Voice._event(Object.assign({}, ev, { id: 's4' })); }, SHOW);
    assert.strictEqual((await p.evaluate(() => RH_VoiceCard._panel())).on, false);
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(300);
    const ps = await p.evaluate(() => RH_VoiceCard._panel()); assert.ok(ps.on && ps.id === 's4', JSON.stringify(ps));
    await p.keyboard.press('Escape');
  });
  await t('on resume the launcher asks the relay for a pending show (GET /tv/pending)', async () => {
    p.tv.length = 0;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForTimeout(300);
    assert.ok(p.tv.find(x => x.m === 'GET' && x.u === '/tv/pending'), JSON.stringify(p.tv));
  });
  await t('screensaver stays off while the card or panel is up', async () => {
    await p.evaluate(() => { RH_VoiceCard._reset(); RH_Voice._event({ type: 'start', session: 5009, query: 'q', ts: Date.now() }); });
    assert.ok(await p.evaluate(() => RH_VoiceCard.busy));
    await p.keyboard.press('Escape');
    assert.strictEqual(await p.evaluate(() => RH_VoiceCard.busy), false);
  });
  await t('no page errors', async () => assert.deepStrictEqual(p.errs, []));

  const old = await open('vcard=0&relay=' + encodeURIComponent(R));
  await old.waitForFunction(() => RH_Voice.available, null, { timeout: 5000 });
  await t('?vcard=0 restores v6.1: phone questions open the full overlay', async () => {
    await old.evaluate(() => RH_Voice._event({ type: 'start', session: 7000, query: 'q', ts: Date.now() }));
    assert.ok(await old.evaluate(() => RH_Voice.open && !RH_VoiceCard.visible));
  });
  console.log(pass + '/' + (pass + fail) + ' tv card tests passed');
  await browser.close(); relay.server.close(); process.exit(fail ? 1 : 0);
});
