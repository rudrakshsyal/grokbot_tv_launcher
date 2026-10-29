// Renders preview-v4-stats.png: the TV answer panel after a LIVE relay request, stats line collapsed (left) and Info-expanded card (right).
// usage: node tools/preview-v4-stats.js "question"   (uses relay/.env brain; nothing is fabricated)
const path = require('path'), http = require('http'), fs = require('fs');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
process.env.LOG = '0';
const relay = require('../relay/server');
const root = path.join(__dirname, '..'), Q = process.argv[2] || 'a funny movie on Netflix under 2 hours';
relay.server.listen(0, '127.0.0.1', async () => {
  const R = 'http://127.0.0.1:' + relay.server.address().port;
  const b = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await p.goto('file://' + path.join(root, 'index.html') + '?still=1&relay=' + encodeURIComponent(R)); await p.waitForTimeout(1500);
  await p.waitForFunction(() => RH_Voice.available, null, { timeout: 5000 });
  http.request(R + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => r.resume()).end(JSON.stringify({ text: Q }));
  await p.waitForFunction(() => RH_Voice.state === 'done' || RH_Voice.state === 'error', null, { timeout: 60000 });
  await p.waitForTimeout(2500);   // posters + stats fade-in
  const st = (await p.evaluate(() => RH_Voice.stats())).stats;
  console.log('live stats:', JSON.stringify({ model: st && st.model, tokens: st && st.tokens, totalMs: st && st.totalMs, hops: st && st.hops }));
  await p.screenshot({ path: '/tmp/st-a.png' });
  await p.keyboard.press('i'); await p.waitForTimeout(500);
  await p.screenshot({ path: '/tmp/st-b.png' });
  const img = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  const c = await (await b.newContext({ viewport: { width: 1920, height: 600 } })).newPage();
  await c.setContent('<body style="margin:0;background:#0b0c14;font:600 20px system-ui;color:#9aa0b8;display:flex;gap:20px;padding:20px">' +
    [['/tmp/st-a.png', 'Collapsed (default) \u2014 one quiet line under the answer'], ['/tmp/st-b.png', 'Info key \u2192 details card (Back hides it)']].map(x =>
      '<figure style="margin:0;flex:1"><img src="' + img(x[0]) + '" style="width:100%;border-radius:10px;display:block"><figcaption style="margin-top:10px">' + x[1] + '</figcaption></figure>').join('') + '</body>');
  await c.screenshot({ path: path.join(root, 'preview-v4-stats.png'), fullPage: true });
  console.log('wrote preview-v4-stats.png'); await b.close(); relay.server.close(); process.exit(0);
});
