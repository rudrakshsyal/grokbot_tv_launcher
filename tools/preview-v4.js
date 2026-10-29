// v4 previews: voice overlay. Starts the relay in MOCK mode (replays relay/mock-session.json, a recorded real run),
// opens the launcher with ?relay=…, asks, and screenshots mid-run and the finished answer.
// usage: node tools/preview-v4.js [root] [out prefix]   -> preview-v4-voice-working.png, preview-v4-voice-done.png
const path = require('path'), http = require('http');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
process.env.MOCK = '1'; process.env.MOCK_SLOW = '6'; process.env.LOG = '0';
const relay = require('../relay/server');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const pre = process.argv[3] || path.join(__dirname, '..', 'preview-v4-voice-');
relay.server.listen(0, '127.0.0.1', async () => {
  const port = relay.server.address().port, R = 'http://127.0.0.1:' + port;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--force-color-profile=srgb'] });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('file://' + path.join(root, 'index.html') + '?still=1&relay=' + encodeURIComponent(R));
  await page.waitForFunction(() => document.body.classList.contains('wp-ready'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => window.RH_Voice && RH_Voice.available, null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  const r = http.request(R + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); r.end('{"text":"preview"}');
  await page.waitForFunction(() => RH_Voice.steps().some(s => s.state === 'live' && /Checking runtimes/.test(s.label)), null, { timeout: 30000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: pre + 'working.png' }); console.log('saved', pre + 'working.png');
  await page.waitForFunction(() => RH_Voice.state === 'done', null, { timeout: 30000 });
  await page.waitForFunction(() => [].every.call(document.querySelectorAll('.vx-art img'), i => i.complete), null, { timeout: 10000 }).catch(() => {});
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(900);   // second result selected
  await page.screenshot({ path: pre + 'done.png' }); console.log('saved', pre + 'done.png');
  console.log(JSON.stringify(await page.evaluate(() => ({ steps: RH_Voice.steps().map(s => s.label + ' | ' + s.detail + ' | ' + s.ms), sel: RH_Voice.selected() }))));
  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
  await browser.close(); relay.server.close(); process.exit(0);
});
