// v6.2 previews: corner card + "Show on TV" panel on the launcher (1920x1080, headless Chrome). Relay in-process, MOCK, no TV, no Gemini.
// usage: node tools/preview-v62.js   -> preview-v62-card.png, preview-v62-panel.png   (preview-v62-phone.png comes from tools/test-phone.js)
const path = require('path'), os = require('os'), fs = require('fs');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-prev-'));
for (const k of ['DATA_DIR', 'CHATS_DIR', 'METRICS_DIR', 'LOG_DIR']) process.env[k] = path.join(tmp, k.toLowerCase());
Object.assign(process.env, { MOCK: '1', MOCK_SLOW: '1', LOG: '0' });
const relay = require('../relay/server'), ROOT = path.join(__dirname, '..');
const ANSWER = 'Severance on Apple TV+ is your best bet tonight: a sharp, strange workplace thriller, and season two pays off. If you want something lighter, The Bear on Hulu has short episodes.';
const LONG = 'Three good picks for tonight, all on services you have:\n\n' +
  '- **Severance** (Apple TV+): a sharp, strange workplace thriller. Season two pays off the mysteries of season one, so it is a great time to binge.\n' +
  '- **The Bear** (FX on Hulu): loud, fast and very funny kitchen drama with short episodes. Start with season one, episode one.\n' +
  '- **Slow Horses** (Apple TV+): a funny British spy show with Gary Oldman as a brilliant slob. Six episodes a season.\n\n' +
  'If you only have an hour, go with **The Bear**: two episodes and you will know if it is for you. For a long weekend, **Severance** is the one everyone talks about, and both seasons are out now.\n\n' +
  'Runtimes: Severance episodes run 45 to 60 minutes; The Bear runs 20 to 35; Slow Horses about 45. All three are rated above 8 on IMDb.\n\n' +
  'Want me to start one? Just say "play Severance" from the phone.';
relay.server.listen(0, '127.0.0.1', async () => {
  const R = 'http://127.0.0.1:' + relay.server.address().port;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--force-color-profile=srgb'] });
  const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  p.on('pageerror', e => console.error('pageerror', String(e)));
  await p.route(R + '/tv/**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: rt.request().url().indexOf('/tv/pending') > 0 ? '{"ok":true,"pending":null}' : '{"ok":true}' }));
  await p.goto('file://' + path.join(ROOT, 'index.html') + '?still=1&discover=0&relay=' + encodeURIComponent(R)); await p.waitForTimeout(2500);
  await p.waitForFunction(() => window.RH_Voice && RH_Voice.available, null, { timeout: 8000 });
  await p.evaluate(a => { RH_VoiceCard._reset(); const s = 9001;
    RH_Voice._event({ type: 'listening', ts: Date.now() });
    RH_Voice._event({ type: 'start', session: s, query: 'What should I watch tonight?', ts: Date.now() });
    RH_Voice._event({ type: 'answer', session: s, text: a, items: [], ts: Date.now() }); }, ANSWER);
  await p.waitForFunction(() => RH_VoiceCard.state === 'done', null, { timeout: 5000 }); await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(ROOT, 'preview-v62-card.png') });
  await p.evaluate(t => { RH_VoiceCard.hideCard(); RH_VoiceCard.show({ type: 'tv-show', id: 'sprev1', chatTitle: 'Tonight', question: 'What should I watch tonight?', text: t,
    items: [{ title: 'Severance', year: 2022, imdb: '8.7', platformName: 'Apple TV+' }, { title: 'The Bear', year: 2022, imdb: '8.5', platformName: 'Hulu' }, { title: 'Slow Horses', year: 2022, imdb: '8.2', platformName: 'Apple TV+' }],
    prev: { key: 'netflix', name: 'Netflix' }, ts: Date.now() }); }, LONG);
  await p.waitForTimeout(900); await p.keyboard.press('ArrowDown'); await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(ROOT, 'preview-v62-panel.png') });
  await browser.close(); relay.server.close(); try { relay.tv.close(); } catch (e) {} fs.rmSync(tmp, { recursive: true, force: true });
  console.log('previews: preview-v62-card.png, preview-v62-panel.png'); process.exit(0);
});
