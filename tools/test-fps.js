// FPS while moving focus, per glass mode, plus "motion off by default". Headless software GL: compare modes, not absolutes.
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); } })();
const base = 'file://' + require('path').resolve(__dirname, '..', 'index.html');
(async () => { const b = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome' }); let fails = 0;
  for (const q of ['blur=baked', 'blur=live', 'blur=off', 'blur=baked&motion=1']) {
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    await p.goto(base + '?wp=moraine-lake&' + q); await p.waitForTimeout(2500);
    const r = await p.evaluate(() => new Promise(res => { let i = 0, n = 0, t0 = 0; const iv = setInterval(() => RH_debug.setFocus(RH_debug.rowIndex('apps'), (i++) % 8, true), 150);
      const f = t => { if (!t0) t0 = t; n++; if (t - t0 < 2000) requestAnimationFrame(f); else { clearInterval(iv); res({ fps: n * 1000 / (t - t0), motion: document.body.classList.contains('wp-motion'),
        anim: getComputedStyle(document.querySelector('.wp.on, .wp')).animationName }); } }; requestAnimationFrame(f); }));
    const wantMotion = /motion=1/.test(q); if (r.motion !== wantMotion) fails++;
    console.log(q.padEnd(22), r.fps.toFixed(1) + ' fps', 'motion=' + r.motion, r.motion === wantMotion ? 'ok' : 'FAIL');
    await p.close(); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); await b.close(); process.exit(fails ? 1 : 0); })();
