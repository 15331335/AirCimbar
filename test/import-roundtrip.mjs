#!/usr/bin/env node
/**
 * AirCimbar — import-decoder integration test.
 *
 * Verifies app/js/import.js: decoding a *recorded video* rather than a live
 * camera. Phase 1 records the barcode with MediaRecorder (a stand-in for a
 * screen recording), phase 2 feeds that file to the real import tab through
 * the file input and waits for the reassembled file.
 *
 *   node test/import-roundtrip.mjs [--mode 68] [--size 4096] [--frames 12]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const appDir = path.join(root, 'app');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MODE = arg('mode', '68');
const SIZE = arg('size', '4096');
const FRAMES = arg('frames', '12');

const watchdog = setTimeout(() => { console.error('[imp] watchdog'); try { spawn('pkill', ['-f', 'aircimbar-imp']); } catch { } process.exit(2); }, 240000);

function makePayload(n) {
  const b = new Uint8Array(n); let s = 0x12345678;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s >>> 16) & 0xff; }
  return b;
}
const payload = makePayload(parseInt(SIZE, 10));
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  return {
    send(method, params) {
      const mid = ++id;
      return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
    },
    close() { try { ws.close(); } catch { } },
  };
}
async function waitForTarget(p, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t.webSocketDebuggerUrl;
    } catch { }
    await sleep(250);
  }
  throw new Error('no CDP target');
}
function serve(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (routes[url.pathname]) return routes[url.pathname](req, res);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(appDir, rel));
    if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

/* ======================================================= phase 1: record */
console.log(`[imp] phase 1 — recording barcode video (mode ${MODE}, ${SIZE}B, ${FRAMES} frames)`);
let video = null, videoExt = 'webm', recErr = null, recDone = false;
const s1 = await serve({
  '/__rec': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(path.join(here, 'record-video.html'))); },
  '/video': (req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { video = Buffer.concat(c); res.writeHead(200); res.end('ok'); }); },
  '/done': (req, res) => { req.resume(); res.writeHead(200); res.end('ok'); recDone = true; },
  '/error': (req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { recErr = Buffer.concat(c).toString(); res.writeHead(200); res.end('ok'); recDone = true; }); },
});
const prof1 = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-imp1-'));
const c1 = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader', '--no-first-run', '--disable-extensions',
  `--user-data-dir=${prof1}`,
  `http://127.0.0.1:${s1.port}/__rec?mode=${MODE}&size=${SIZE}&frames=${FRAMES}`], { stdio: ['ignore', 'pipe', 'pipe'] });
c1.stderr.on('data', () => { });
for (let i = 0; i < 320 && !recDone; i++) await sleep(250);
c1.kill('SIGKILL'); s1.server.close();

if (recErr) { console.error('[imp] recorder page error:\n' + recErr); process.exit(1); }
if (!video || video.length < 1000) { console.error('[imp] no video produced (' + (video ? video.length : 0) + ' bytes)'); process.exit(1); }
const videoPath = path.join(os.tmpdir(), `aircimbar-import-${Date.now()}.${videoExt}`);
fs.writeFileSync(videoPath, video);
console.log(`[imp] recorded ${(video.length / 1024).toFixed(0)} KB -> ${videoPath}`);

/* ==================================================== phase 2: decode it */
console.log('[imp] phase 2 — feeding it to the real import tab');
const s2 = await serve({});
const prof2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-imp2-'));
const dbgPort = 9600 + Math.floor(Math.random() * 90);
const c2 = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader', '--no-first-run', '--disable-extensions', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${prof2}`,
  `http://127.0.0.1:${s2.port}/?tab=import`], { stdio: ['ignore', 'pipe', 'pipe'] });
let c2Log = '';
c2.stderr.on('data', (d) => { c2Log += d; });

let out = null;
try {
  const cdp = await cdpSession(await waitForTarget(dbgPort));
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  const ready = async () => {
    try { const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }); return r.result && r.result.value; }
    catch { return null; }
  };
  for (let i = 0; i < 80; i++) { if (await ready() === 'complete') break; await sleep(150); }
  for (let i = 0; i < 100; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: '!!(window.AirCimbarImport && document.getElementById("importInput"))', returnByValue: true });
    if (r.result && r.result.value) break;
    await sleep(100);
  }

  /* hand the file to the real <input type=file> */
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#importInput' });
  if (!q.nodeId) throw new Error('could not find #importInput');
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [videoPath] });
  await sleep(500);

  const expr = `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const input = document.getElementById('importInput');
    if (!input.files || !input.files.length) return JSON.stringify({ fatal: 'file not attached to input' });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);

    const btn = document.getElementById('btnDecodeImport');
    if (btn.disabled) return JSON.stringify({ fatal: 'decode button still disabled' });

    const result = await new Promise(resolve => {
      const t = setTimeout(() => resolve({ timeout: true, st: window.AirCimbarImport.state }), 150000);
      window.AirCimbarImport.on('complete', async (info) => {
        clearTimeout(t);
        const buf = new Uint8Array(await info.blob.arrayBuffer());
        const h = await crypto.subtle.digest('SHA-256', buf);
        resolve({ name: info.name, size: info.size,
          sha: [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join(''),
          frames: window.AirCimbarImport.state.frames,
          scanOk: window.AirCimbarImport.state.scanOk,
          lockedMode: window.AirCimbarImport.state.lockedMode });
      });
      window.AirCimbarImport.on('incomplete', (s) => { /* let the timeout report it */ });
      btn.click();
    });
    return JSON.stringify(result);
  })()`;

  for (let attempt = 1; attempt <= 3 && !out; attempt++) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      const raw = r.result && r.result.value;
      out = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (!out && r.exceptionDetails) console.error('[imp] page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    } catch (e) { console.error(`[imp] attempt ${attempt}: ${e.message}`); await sleep(2500); }
  }
  cdp.close();
} catch (e) { console.error('[imp] driver failure: ' + e.message); }
c2.kill('SIGKILL'); s2.server.close();
try { fs.unlinkSync(videoPath); } catch { }

clearTimeout(watchdog);
if (!out) {
  console.error('❌ import decode produced no result');
  console.error(c2Log.split('\n').filter(l => !/crashpad|cv_display_link|keychain|SecItemCopyMatching|password_store|Encryption|gl_utils|Fontconfig/.test(l)).slice(-15).join('\n'));
  process.exit(1);
}
if (out.fatal) { console.error('❌ ' + out.fatal); process.exit(1); }
if (out.timeout) {
  console.error('❌ import decode did not finish');
  console.error(`   frames=${out.st.frames} scanOk=${out.st.scanOk} progress=${out.st.progress} done=${out.st.done}`);
  process.exit(1);
}

console.log(`[imp] decoded: frames=${out.frames} hit=${out.scanOk} lockedMode=${out.lockedMode}`);
console.log(`[imp] file="${out.name}" size=${out.size}B`);
console.log(`[imp] expected sha256 = ${payloadSha}`);
console.log(`[imp] actual   sha256 = ${out.sha}`);

const ok = out.size === payload.length && out.sha === payloadSha;
console.log('');
console.log(ok
  ? `✅ IMPORT PATH OK — recorded video -> import.js -> ${out.size}B byte-identical (mode ${MODE})`
  : '❌ IMPORT PATH FAILED');
process.exit(ok ? 0 : 1);
