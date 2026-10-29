// Voice overlay tests (headless Chrome). Relay runs in-process in MOCK mode. usage: node tools/test-voice.js [root]
const path = require('path'), http = require('http'), assert = require('assert');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
process.env.MOCK = '1'; process.env.MOCK_SLOW = '1'; process.env.LOG = '0';
const relay = require('../relay/server');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } }
relay.server.listen(0, '127.0.0.1', async () => {
  const R = 'http://127.0.0.1:' + relay.server.address().port;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
  const open = async (q) => { const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); const errs = [];
    p.on('pageerror', e => errs.push(String(e))); p.errs = errs;
    await p.goto('file://' + path.join(root, 'index.html') + '?still=1&' + q); await p.waitForTimeout(1500); return p; };
  const ask = () => new Promise(r => { const q = http.request(R + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', r); }); q.end('{"text":"x"}'); });

  const dead = await open('relay=' + encodeURIComponent('http://127.0.0.1:9'));
  await t('unreachable relay: feature hidden, no overlay in DOM', async () => {
    assert.strictEqual(await dead.evaluate(() => RH_Voice.available), false);
    await dead.keyboard.press('v'); await dead.waitForTimeout(300);
    assert.strictEqual(await dead.evaluate(() => !!document.getElementById('voice')), false);
    assert.strictEqual(await dead.evaluate(() => RH_Voice.open), false);
  });
  await t('unreachable relay: home keys still work (no JS errors)', async () => { await dead.keyboard.press('ArrowUp'); await dead.waitForTimeout(300); assert.deepStrictEqual(dead.errs, []); });
  const off = await open('relay=off');
  await t('relay=off disables voice', async () => assert.strictEqual(await off.evaluate(() => RH_Voice.available || !!RH_Voice.es), false));

  const p = await open('relay=' + encodeURIComponent(R));
  await p.waitForFunction(() => RH_Voice.available, null, { timeout: 5000 });
  await t('Play/Pause key ("v" in browser) opens the idle overlay; Back closes', async () => {
    await p.keyboard.press('v'); await p.waitForTimeout(400);
    assert.ok(await p.evaluate(() => RH_Voice.open && document.getElementById('voice').classList.contains('on')));
    assert.ok(/on your phone/.test(await p.$eval('#vxQ', e => e.textContent)));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    assert.strictEqual(await p.evaluate(() => RH_Voice.open), false);
  });
  await t('MediaPlayPause keyCode 10252 toggles', async () => {
    await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 10252, bubbles: true })));
    await p.waitForTimeout(200); const a = await p.evaluate(() => RH_Voice.open);
    await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 10252, bubbles: true })));
    await p.waitForTimeout(200); const b = await p.evaluate(() => RH_Voice.open);
    assert.ok(a === true && b === false, 'open=' + a + ' then ' + b);
  });
  await t('relay events open the overlay and fill the timeline', async () => {
    await ask();
    await p.waitForFunction(() => RH_Voice.state === 'done', null, { timeout: 15000 });
    const st = await p.evaluate(() => RH_Voice.steps().map(s => s.state));
    assert.strictEqual(st.length, 5); assert.ok(st.every(s => s === 'ok'), st.join());
    assert.strictEqual(await p.$$eval('.vx-row', r => r.length), 3);
    assert.ok(/Done · \d+ ms|Done · [\d.]+ s/.test(await p.$eval('#vxCap', e => e.textContent)));
  });
  await t('stats line fades in collapsed; Info/Yellow/i expand the card; Back collapses it first', async () => {
    await p.waitForTimeout(900);
    assert.ok(await p.$eval('#vxStats', e => e.classList.contains('in') && /mock replay · no tokens · /.test(e.textContent)));
    assert.strictEqual(await p.$eval('#vxSd', e => e.classList.contains('on')), false);
    await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 457, bubbles: true })));   // Tizen Info
    assert.ok(await p.$eval('#vxSd', e => e.classList.contains('on')));
    await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));   // Yellow
    assert.strictEqual(await p.$eval('#vxSd', e => e.classList.contains('on')), false);
    await p.keyboard.press('i'); assert.ok(await p.$eval('#vxSd', e => e.classList.contains('on')));
    await p.keyboard.press('Escape'); await p.waitForTimeout(100);
    assert.strictEqual(await p.$eval('#vxSd', e => e.classList.contains('on')), false);
    assert.strictEqual(await p.evaluate(() => RH_Voice.open), true);
  });
  await t('arrows move the selection and clamp', async () => {
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowRight');
    assert.strictEqual(await p.evaluate(() => RH_Voice.selected()), 2);
    await p.keyboard.press('ArrowLeft'); assert.strictEqual(await p.evaluate(() => RH_Voice.selected()), 1);
    assert.strictEqual(await p.$$eval('.vx-row.sel', r => r.length), 1);
  });
  await t('arrow keys do not move the home focus while open', async () => {
    const f0 = await p.evaluate(() => JSON.stringify(RH_debug.focus));
    await p.keyboard.press('ArrowUp'); await p.waitForTimeout(200);
    assert.strictEqual(await p.evaluate(() => JSON.stringify(RH_debug.focus)), f0);
  });
  await t('OK opens the selected title’s platform app', async () => {
    await p.evaluate(() => { window.__launched = []; RH_Home.launchApp = k => window.__launched.push(k); });
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    assert.deepStrictEqual(await p.evaluate(() => window.__launched), ['netflix']);
    assert.strictEqual(await p.evaluate(() => RH_Voice.open), false);
  });
  await t('launcher_action events: open_app and show_platform', async () => {
    await p.evaluate(() => { window.__shown = []; window.__launched = []; RH_Home.showPlatform = k => window.__shown.push(k);
      const s = 999; RH_Voice._event({ type: 'start', session: s, query: 'open hulu' });
      RH_Voice._event({ type: 'action', session: s, action: 'open_app', app: 'hulu' }); RH_Voice._event({ type: 'action', session: s, action: 'show_platform', app: 'hbomax' }); });
    await p.waitForTimeout(1700);
    assert.deepStrictEqual(await p.evaluate(() => [window.__launched, window.__shown]), [['hulu'], ['hbomax']]);
  });
  await t('real showPlatform switches the Discover platform', async () => {
    const pl = await p.evaluate(() => RH_debug.platforms());
    if (pl.length < 2) { console.log('   (skipped: no live platforms in this run)'); return; }
    await p.reload(); await p.waitForTimeout(1500);
    await p.evaluate(k => RH_Home.showPlatform(k), pl[1]); await p.waitForTimeout(500);
    assert.strictEqual(await p.evaluate(() => RH_debug.platform), pl[1]);
  });
  await t('no page errors', async () => assert.deepStrictEqual(p.errs, []));
  console.log(pass + '/' + (pass + fail) + ' voice tests passed');
  await browser.close(); relay.server.close(); process.exit(fail ? 1 : 0);
});
