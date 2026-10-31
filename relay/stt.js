'use strict';
// v6 speech-to-text for the phone's hold-to-talk recordings (POST /stt, raw audio body).
//   whisper : local whisper.cpp (tools/install-whisper.sh) — free, offline, private. Audio is converted with macOS's
//             built-in afconvert to 16 kHz mono WAV first.
//   gemini  : the same free-tier Gemini key as the brain, counted in the same daily caps (requests + tokens).
//   STT=auto (default): whisper if installed, else gemini if a Gemini key is set, else off (the phone then uses Web Speech).
//   STT=whisper | gemini | off forces one. STT_FALLBACK=0 stops auto from trying gemini after a whisper failure.
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https'), http = require('http'), { execFile } = require('child_process'), { URL } = require('url');
const LLM = require('./brain-llm');
const E = process.env;
const MAX_BYTES = () => +(E.STT_MAX_BYTES || 3 * 1024 * 1024);
const MAX_SEC = () => +(E.STT_MAX_SEC || 30);
const MIMES = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' };
const baseMime = m => String(m || '').split(';')[0].trim().toLowerCase();

const exists = f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };
function whisperPaths() {
  const home = E.WHISPER_DIR || path.join(os.homedir(), '.glasshome', 'whisper.cpp');
  const m = n => path.join(home, 'models', 'ggml-' + n + '.bin');
  // no name given: the first installed of small (Apple Silicon default), base (Intel default), medium
  const model = E.WHISPER_MODEL || (E.WHISPER_MODEL_NAME ? m(E.WHISPER_MODEL_NAME) : (['small', 'base', 'medium'].map(m).filter(exists)[0] || m('small')));
  return { bin: E.WHISPER_BIN || path.join(home, 'build', 'bin', 'whisper-cli'), model };
}
function whisperReady() { const w = whisperPaths(); return exists(w.bin) && exists(w.model); }
function afconvertBin() { return E.AFCONVERT || '/usr/bin/afconvert'; }
function geminiEp() {
  const key = E.STT_GEMINI_KEY || E.GEMINI_API_KEY || E.GOOGLE_API_KEY || '';
  const ep = LLM.endpoints().filter(e => /generativelanguage\.googleapis\.com/.test(e.base) || e.name === 'gemini')[0];
  const k = key || (ep && ep.key);
  if (!k || E.STT_GEMINI === '0') return null;
  return { name: 'gemini-stt', key: k, model: E.STT_GEMINI_MODEL || (ep && ep.model) || 'gemini-3.8-flash',
    base: (E.STT_GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '') };
}
function engine() {
  const m = String(E.STT || 'auto').toLowerCase();
  if (m === 'off') return 'off';
  if (m === 'whisper') return whisperReady() ? 'whisper' : 'off';
  if (m === 'gemini') return geminiEp() ? 'gemini' : 'off';
  return whisperReady() ? 'whisper' : geminiEp() ? 'gemini' : 'off';
}
function status() {
  const e = engine();
  return { engine: e, maxBytes: MAX_BYTES(), maxSec: MAX_SEC(), whisper: whisperReady(), gemini: !!geminiEp(), fallback: e === 'whisper' && E.STT_FALLBACK !== '0' && !!geminiEp() && String(E.STT || 'auto') === 'auto' };
}

function run(bin, args, ms) {
  return new Promise((res, rej) => {
    execFile(bin, args, { timeout: ms, maxBuffer: 1 << 20, windowsHide: true }, (err, out, errOut) => {
      if (err) { const e = new Error((err.killed ? 'timeout' : 'exit ' + (err.code != null ? err.code : '?')) + ' ' + String(errOut || '').trim().split('\n').pop().slice(0, 120)); e.code = err.code; return rej(e); }
      res(String(out || ''));
    });
  });
}
async function toWav(file, dir, mime) {
  if (MIMES[mime] === 'wav') return file;
  const out = path.join(dir, 'in16k.wav');
  await run(afconvertBin(), ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file, out], 15000);
  if (!exists(out)) throw new Error('afconvert produced nothing');
  return out;
}
// seconds of audio in a 16-bit PCM WAV (RIFF header); null if unknown
function wavSeconds(file) {
  try {
    const b = fs.readFileSync(file); if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
    let o = 12, rate = 0, ch = 1, bits = 16;
    while (o + 8 <= b.length) {
      const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4);
      if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22); }
      if (id === 'data') return rate ? Math.min(sz, b.length - o - 8) / (rate * ch * bits / 8) : null;
      o += 8 + sz + (sz & 1);
    }
  } catch (e) {}
  return null;
}
const langCode = l => (/^hi/i.test(l || '') ? 'hi' : 'en');
const cleanText = t => String(t || '').replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|inaudible)[^\]]*\]|\((?:music|silence|inaudible)[^)]*\)/ig, ' ').replace(/\s+/g, ' ').trim();

async function whisper(wav, lang) {
  const w = whisperPaths();
  const args = ['-m', w.model, '-f', wav, '-nt', '-np', '-l', langCode(lang), '-t', String(E.WHISPER_THREADS || Math.max(2, Math.min(8, os.cpus().length - 2)))];
  if (E.WHISPER_PROMPT !== '0') args.push('--prompt', E.WHISPER_PROMPT || 'Netflix, YouTube, Hulu, Prime Video, Disney+, HBO Max, Apple TV, Yo-Yo.');
  return cleanText(await run(w.bin, args, +(E.WHISPER_TIMEOUT_MS || 30000)));
}
function postJSON(url, body, headers, ms) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), data = JSON.stringify(body), lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.setTimeout(ms || 20000, () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(data);
  });
}
async function gemini(buf, mime, lang) {
  const ep = geminiEp(); if (!ep) throw new Error('no Gemini key');
  const why = LLM.reserve(); if (why) { const e = new Error('daily Gemini cap reached (' + why + ')'); e.budget = true; throw e; }
  const body = {
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this short voice command exactly as spoken' + (langCode(lang) === 'hi' ? ' (Hindi or Hinglish; keep English words in Latin script)' : '') + '. Output only the transcript, nothing else. If there is no speech, output nothing.' },
      { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
    generationConfig: { temperature: 0, maxOutputTokens: +(E.STT_GEMINI_TOKENS || 120) }
  };
  const r = await postJSON(ep.base + '/models/' + encodeURIComponent(ep.model) + ':generateContent', body, { 'x-goog-api-key': ep.key }, +(E.STT_GEMINI_TIMEOUT_MS || 20000));
  LLM.checkBilling(ep, r.status, r.body.slice(0, 4000));
  let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
  const used = (j.usageMetadata && j.usageMetadata.totalTokenCount) || Math.round(buf.length / 500);   // ~32 audio tokens/s
  LLM.spend(used);
  if (r.status >= 400) { const e = new Error('Gemini HTTP ' + r.status); e.status = r.status; throw e; }
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return { text: cleanText(parts.map(p => p.text || '').join(' ')), tokens: used };
}

function logLine(o) {
  if (E.STT_LOG === '0') return;
  try { const dir = E.LOG_DIR || path.join(__dirname, 'logs'); fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'stt.jsonl'), JSON.stringify(o) + '\n', { mode: 0o600 }); } catch (e) {}
}
// -> { text, engine, ms, seconds, tokens? }; throws Error with .http (status) and .user (message for the phone)
async function transcribe(buf, o) {
  o = o || {};
  const t0 = Date.now(), mime = baseMime(o.mime), eng = engine(), fail = (http, user, err) => Object.assign(err || new Error(user), { http, user });
  const rec = { at: new Date().toISOString(), engine: eng, bytes: buf.length, mime, lang: o.lang || 'en-US', clientSec: o.seconds || null };
  try {
    if (eng === 'off') throw fail(503, 'Speech-to-text is off on the relay.');
    if (!buf.length) throw fail(400, 'No audio.');
    if (buf.length > MAX_BYTES()) throw fail(413, 'Recording too long.');
    if (o.seconds && o.seconds > MAX_SEC() + 1) throw fail(413, 'Recording too long (max ' + MAX_SEC() + ' s).');
    if (!MIMES[mime]) throw fail(415, 'Unsupported audio type.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stt-'));
    try {
      const inFile = path.join(dir, 'in.' + MIMES[mime]); fs.writeFileSync(inFile, buf, { mode: 0o600 });
      let wav = null, convErr = null;
      try { wav = await toWav(inFile, dir, mime); } catch (e) { convErr = e; }
      const secs = wav ? wavSeconds(wav) : null; rec.seconds = secs != null ? +secs.toFixed(2) : null;
      if (secs != null && secs > MAX_SEC() + 1) throw fail(413, 'Recording too long (max ' + MAX_SEC() + ' s).');
      if (secs != null && secs < 0.3) throw fail(422, 'Didn\u2019t catch that.');
      let out = null;
      if (eng === 'whisper') {
        try {
          if (!wav) throw convErr || new Error('no wav');
          const t1 = Date.now(); out = { text: await whisper(wav, o.lang), engine: 'whisper', engineMs: Date.now() - t1 };
        } catch (e) {
          rec.whisperError = String(e.message).slice(0, 160);
          if (String(E.STT || 'auto') !== 'auto' || E.STT_FALLBACK === '0' || !geminiEp()) throw fail(502, 'Speech-to-text failed.', e);
        }
      }
      if (!out) {
        const send = wav ? fs.readFileSync(wav) : buf, sm = wav ? 'audio/wav' : mime;
        const t1 = Date.now(), g = await gemini(send, sm, o.lang).catch(e => { throw fail(e.budget ? 429 : 502, e.budget ? 'Gemini\u2019s free daily limit is used up; use the keyboard or Web Speech.' : 'Speech-to-text failed.', e); });
        out = { text: g.text, engine: 'gemini', engineMs: Date.now() - t1, tokens: g.tokens, converted: !!wav };
      }
      out.ms = Date.now() - t0; out.seconds = rec.seconds;
      logLine(Object.assign(rec, { ok: true, used: out.engine, ms: out.ms, engineMs: out.engineMs, chars: out.text.length, tokens: out.tokens }));
      return out;
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  } catch (e) {
    logLine(Object.assign(rec, { ok: false, ms: Date.now() - t0, error: String(e.user || e.message).slice(0, 160), cause: e.user && e.message !== e.user ? String(e.message).slice(0, 160) : undefined }));
    if (!e.http) { e.http = 502; e.user = 'Speech-to-text failed.'; }
    throw e;
  }
}
function stats() {
  let lines = [];
  try { lines = fs.readFileSync(path.join(E.LOG_DIR || path.join(__dirname, 'logs'), 'stt.jsonl'), 'utf8').trim().split('\n').slice(-500).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
  const ok = lines.filter(l => l.ok), by = {};
  ok.forEach(l => { const b = by[l.used] = by[l.used] || { n: 0, ms: [] }; b.n++; b.ms.push(l.ms); });
  Object.keys(by).forEach(k => { const a = by[k].ms.sort((x, y) => x - y); by[k] = { n: by[k].n, medianMs: a[a.length >> 1], p90Ms: a[Math.floor(a.length * 0.9)] }; });
  return { total: lines.length, ok: ok.length, failed: lines.length - ok.length, byEngine: by };
}
module.exports = { transcribe, engine, status, stats, wavSeconds, whisperPaths, MIMES, MAX_BYTES, MAX_SEC };
