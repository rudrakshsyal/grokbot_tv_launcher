'use strict';
// /stt against fakes: fake afconvert + whisper-cli (small node scripts), fake Gemini generateContent server.
// Never runs real whisper, never calls Google. Run with GEMINI_API_KEY unset.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok  ' + m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-test-'));
const argLog = path.join(tmp, 'args.log');
// fake afconvert: writes a 16 kHz mono WAV whose length comes from the input's first line ("sec=<n>"); "BROKEN" -> exit 1
fs.writeFileSync(path.join(tmp, 'afconvert'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(argLog)}, 'afconvert ' + a.slice(0, 6).join(' ') + '\\n');
const src = fs.readFileSync(a[6], 'utf8'); if (/BROKEN/.test(src)) { console.error('Error: AudioFileOpen failed'); process.exit(1); }
const sec = +((/sec=([\\d.]+)/.exec(src) || [])[1] || 2), n = Math.round(sec * 16000) * 2, h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n, 40);
fs.writeFileSync(a[7], Buffer.concat([h, Buffer.alloc(n)]));
`, { mode: 0o755 });
// fake whisper-cli: prints a transcript with a [BLANK_AUDIO] tag; FAKE_WHISPER_FAIL=1 -> exit 3
fs.writeFileSync(path.join(tmp, 'whisper-cli'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(argLog)}, 'whisper ' + a.join(' ') + '\\n');
if (process.env.FAKE_WHISPER_FAIL === '1') { console.error('whisper_init: failed to load model'); process.exit(3); }
const l = a[a.indexOf('-l') + 1]; console.log(l === 'hi' ? ' netflix chalao [BLANK_AUDIO]' : ' play some rufus du sol on youtube [BLANK_AUDIO]');
`, { mode: 0o755 });
fs.writeFileSync(path.join(tmp, 'ggml-small.bin'), 'fake model');
const G = { calls: [] };
const gem = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const j = JSON.parse(b); G.calls.push({ url: req.url, key: req.headers['x-goog-api-key'], body: j });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'what is the weather tomorrow' }] } }], usageMetadata: { totalTokenCount: 140 } }));
}); });

(async () => {
  await new Promise(r => gem.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DATA_DIR: tmp, CHATS_DIR: path.join(tmp, 'chats'), METRICS_DIR: path.join(tmp, 'm'), LOG_DIR: path.join(tmp, 'logs'), METRICS: '0', LOG: '0',
    LLM: 'off', GEMINI_API_KEY: '', AFCONVERT: path.join(tmp, 'afconvert'), WHISPER_BIN: path.join(tmp, 'whisper-cli'), WHISPER_MODEL: path.join(tmp, 'ggml-small.bin'),
    STT_GEMINI_BASE: 'http://127.0.0.1:' + gem.address().port + '/v1beta', STT_GEMINI_MODEL: 'fake-flash', LLM_MAX_REQUESTS_PER_DAY: '1000', OLLAMA_FALLBACK: '0' });
  const relay = require('../server'), STT = require('../stt'), LLM = require('../brain-llm');
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + relay.server.address().port;
  const post = async (body, type, qs, fast) => { if (!fast) await new Promise(z => setTimeout(z, 360)); const r = await fetch(base + '/stt' + (qs || '?lang=en-US&sec=2'), { method: 'POST', headers: { 'Content-Type': type || 'audio/mp4' }, body }); return { status: r.status, j: await r.json() }; };
  const clip = s => Buffer.from('sec=' + s + '\n' + 'x'.repeat(2000));

  // 1. whisper path (auto: installed -> whisper)
  ok(STT.engine() === 'whisper' && (await (await fetch(base + '/stt')).json()).engine === 'whisper', 'STT=auto + whisper-cli + model present -> engine whisper (GET /stt)');
  let r = await post(clip(2), 'audio/mp4;codecs=mp4a.40.2');
  ok(r.status === 200 && r.j.text === 'play some rufus du sol on youtube' && r.j.engine === 'whisper', 'iPhone audio/mp4 -> afconvert -> whisper -> "' + r.j.text + '" ([BLANK_AUDIO] removed)');
  const log = fs.readFileSync(argLog, 'utf8');
  ok(/afconvert -f WAVE -d LEI16@16000 -c 1/.test(log) && /whisper -m \S+ggml-small\.bin -f \S+in16k\.wav -nt -np -l en -t \d+ --prompt Netflix/.test(log), 'afconvert to 16 kHz mono WAV; whisper-cli -nt -np -l en --prompt (vocabulary hint)');
  r = await post(clip(2), 'audio/webm', '?lang=hi-IN&sec=2');
  ok(r.status === 200 && r.j.text === 'netflix chalao' && / -l hi /.test(fs.readFileSync(argLog, 'utf8')), 'hi-IN -> whisper -l hi');
  ok(fs.readdirSync(os.tmpdir()).filter(d => /^gh-stt-/.test(d)).length === 0, 'temp audio files removed after each request');
  // 2. limits
  r = await post(Buffer.alloc(0)); ok(r.status === 400, 'empty body -> 400');
  r = await post(clip(2), 'text/plain'); ok(r.status === 415, 'non-audio type -> 415');
  r = await post(clip(2), 'audio/mp4', '?sec=45'); ok(r.status === 413 && /max 30 s/.test(r.j.error), 'client says 45 s -> 413 (max 30 s)');
  r = await post(clip(40), 'audio/mp4', '?sec=3'); ok(r.status === 413, 'decoded WAV 40 s (client lied) -> 413');
  r = await post(clip(0.1)); ok(r.status === 422 && /Didn’t catch/.test(r.j.error), '0.1 s tap -> 422 "Didn’t catch that."');
  r = await post(Buffer.alloc(3 * 1024 * 1024 + 10, 65)); ok(r.status === 413, '> 3 MB body -> 413 (stream cut off)');
  // 3. whisper fails, no Gemini key -> 502; with key + auto -> Gemini fallback
  process.env.FAKE_WHISPER_FAIL = '1';
  r = await post(clip(2)); ok(r.status === 502 && G.calls.length === 0, 'whisper fails, no Gemini key -> 502 (phone falls back to Web Speech)');
  process.env.STT_GEMINI_KEY = 'fake-key-not-real';
  const b0 = LLM.budgetStatus();
  r = await post(clip(3));
  const g = G.calls[0];
  ok(r.status === 200 && r.j.engine === 'gemini' && r.j.text === 'what is the weather tomorrow', 'whisper fails + STT=auto + key -> Gemini fallback');
  ok(/\/v1beta\/models\/fake-flash:generateContent$/.test(g.url) && g.key === 'fake-key-not-real' && g.body.contents[0].parts[1].inline_data.mime_type === 'audio/wav' && g.body.generationConfig.maxOutputTokens === 120, 'Gemini: native generateContent, key in x-goog-api-key header, converted WAV inline, 120 max tokens');
  const b1 = LLM.budgetStatus();
  ok(b1.requests === b0.requests + 1 && b1.tokens === b0.tokens + 140, 'Gemini STT counted in the shared daily budget (+1 request, +140 tokens)');
  process.env.STT_FALLBACK = '0'; r = await post(clip(2)); ok(r.status === 502 && G.calls.length === 1, 'STT_FALLBACK=0 -> no Gemini call'); delete process.env.STT_FALLBACK;
  // 4. STT=gemini, afconvert fails -> original audio sent as-is
  process.env.STT = 'gemini';
  r = await post(Buffer.from('BROKEN' + 'x'.repeat(100)), 'audio/webm');
  ok(r.status === 200 && G.calls[1].body.contents[0].parts[1].inline_data.mime_type === 'audio/webm', 'STT=gemini + afconvert error -> original webm sent');
  // 5. budget exhausted -> 429 and no call
  process.env.LLM_MAX_REQUESTS_PER_DAY = String(LLM.budgetStatus().requests);
  r = await post(clip(2)); ok(r.status === 429 && /free daily limit/.test(r.j.error) && G.calls.length === 2, 'daily cap reached -> 429, Gemini not called');
  process.env.LLM_MAX_REQUESTS_PER_DAY = '1000';
  // 6. STT=off / whisper forced but missing
  process.env.STT = 'off'; r = await post(clip(2)); ok(r.status === 503 && STT.status().engine === 'off', 'STT=off -> 503');
  process.env.STT = 'whisper'; process.env.WHISPER_MODEL = path.join(tmp, 'missing.bin'); ok(STT.engine() === 'off', 'STT=whisper but model missing -> off');
  process.env.STT = 'auto'; ok(STT.engine() === 'gemini', 'auto without whisper but with key -> gemini');
  delete process.env.STT_GEMINI_KEY; ok(STT.engine() === 'off', 'auto with neither -> off');
  { const wd = path.join(tmp, 'wdir'), saved = process.env.WHISPER_MODEL; delete process.env.WHISPER_MODEL; process.env.WHISPER_DIR = wd;
    fs.mkdirSync(path.join(wd, 'models'), { recursive: true }); fs.writeFileSync(path.join(wd, 'models', 'ggml-base.bin'), 'x');
    ok(/ggml-base\.bin$/.test(STT.whisperPaths().model), 'only base installed (Intel) -> base model picked');
    fs.writeFileSync(path.join(wd, 'models', 'ggml-small.bin'), 'x'); ok(/ggml-small\.bin$/.test(STT.whisperPaths().model), 'small preferred when both installed');
    process.env.WHISPER_MODEL_NAME = 'base'; ok(/ggml-base\.bin$/.test(STT.whisperPaths().model), 'WHISPER_MODEL_NAME overrides');
    delete process.env.WHISPER_MODEL_NAME; delete process.env.WHISPER_DIR; process.env.WHISPER_MODEL = saved; }
  // 7. metrics
  const st = await (await fetch(base + '/stats')).json(), lines = fs.readFileSync(path.join(tmp, 'logs', 'stt.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok(st.stt.byEngine.whisper.n === 2 && st.stt.byEngine.gemini.n === 2 && st.stt.failed >= 8 && lines.every(l => !('text' in l)) && (fs.statSync(path.join(tmp, 'logs', 'stt.jsonl')).mode & 0o777) === 0o600, '/stats.stt: per-engine counts + median/p90 ms; log has no transcripts; mode 600');
  ok(lines.some(l => l.whisperError && /exit 3/.test(l.whisperError)), 'whisper failure reason logged');
  // 8. rate limit
  const codes = []; for (let i = 0; i < 8; i++) codes.push((await post(clip(2), 'audio/mp4', '?sec=2', true)).status);
  ok(codes.indexOf(429) >= 0, 'burst of 8 -> rate limited (' + codes.join(',') + ')');
  relay.server.close(); relay.tvPower.stop(); relay.tv.close(); gem.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('stt: ' + pass + ' passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
