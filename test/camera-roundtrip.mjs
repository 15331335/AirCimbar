#!/usr/bin/env node
/**
 * AirCimbar — camera-path integration test.
 *
 * Exercises the receiver exactly as the phone will: a real getUserMedia
 * stream, frame capture, the scan workers, the fountain sink, and the file
 * assembly in recv.js. The camera is Chrome's fake capture device fed a Y4M
 * recording built from frames rendered by the real sender module.
 *
 *   phase 1  headless Chrome + app/js/send.js  -> barcode frames -> Y4M
 *   phase 2  headless Chrome + app/index.html  -> fake camera -> saved file
 *
 *   node test/camera-roundtrip.mjs [--mode 68] [--size 8192] [--frames 24]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const appDir = path.join(root, 'app');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MODE = parseInt(arg('mode', '68'), 10);
const SIZE = parseInt(arg('size', '8192'), 10);
const FRAMES = parseInt(arg('frames', '24'), 10);
const REPEAT = parseInt(arg('repeat', '4'), 10);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

/* ---------------------------------------------------------------- payload */
function makePayload(n) {
  const b = new Uint8Array(n);
  let s = 0x12345678;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s >>> 16) & 0xff; }
  return b;
}
const payload = makePayload(SIZE);

/* ------------------------------------------- RGBA -> I420 / Y4M writer */
function rgbaToYuv420(rgba, w, h, out, off) {
  const ySize = w * h, cSize = (w >> 1) * (h >> 1);
  let yo = off, uo = off + ySize, vo = off + ySize + cSize;
  const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      out[yo++] = clamp(0.257 * r + 0.504 * g + 0.098 * b + 16);
    }
  }
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let rs = 0, gs = 0, bs = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y + dy) * w + (x + dx)) * 4;
          rs += rgba[i]; gs += rgba[i + 1]; bs += rgba[i + 2];
        }
      }
      const r = rs / 4, g = gs / 4, b = bs / 4;
      const u = clamp(-0.148 * r - 0.291 * g + 0.439 * b + 128);
      const v = clamp(0.439 * r - 0.368 * g - 0.071 * b + 128);
      const ci = (y >> 1) * (w >> 1) + (x >> 1);
      out[uo + ci] = u;
      out[vo + ci] = v;
    }
  }
}

/* Chrome's fake capture device rescales its Y4M to whatever resolution the
   page requests, so the recording must be authored at that exact size or the
   barcode arrives geometrically distorted. Compose a realistic "camera view":
   the barcode, undistorted, centred on a scene background. */
function composeCameraFrames(codeFrames, cw, ch, outW, outH, coverage) {
  const box = Math.round(Math.min(outW, outH) * coverage);
  const ox = Math.round((outW - box) / 2);
  const oy = Math.round((outH - box) / 2);
  return codeFrames.map((code) => {
    const out = Buffer.alloc(outW * outH * 4);
    /* scene backdrop */
    for (let i = 0; i < out.length; i += 4) { out[i] = 26; out[i + 1] = 28; out[i + 2] = 34; out[i + 3] = 255; }
    for (let y = 0; y < box; y++) {
      const sy = Math.min(ch - 1, Math.floor(y * ch / box));
      for (let x = 0; x < box; x++) {
        const sx = Math.min(cw - 1, Math.floor(x * cw / box));
        const si = (sy * cw + sx) * 4;
        const di = ((oy + y) * outW + (ox + x)) * 4;
        out[di] = code[si]; out[di + 1] = code[si + 1]; out[di + 2] = code[si + 2]; out[di + 3] = 255;
      }
    }
    return out;
  });
}

function writeY4M(file, frames, w, h, repeat) {
  const ySize = w * h, cSize = (w >> 1) * (h >> 1);
  const frameLen = ySize + 2 * cSize;
  const total = frames.length * repeat;
  const buf = Buffer.alloc(total * frameLen);
  let off = 0;
  for (let r = 0; r < repeat; r++) {
    for (const f of frames) { rgbaToYuv420(f, w, h, buf, off); off += frameLen; }
  }
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420mpeg2\n`, 'ascii');
  const frameTag = Buffer.from('FRAME\n', 'ascii');
  const parts = [header];
  for (let i = 0; i < total; i++) { parts.push(frameTag, buf.subarray(i * frameLen, (i + 1) * frameLen)); }
  fs.writeFileSync(file, Buffer.concat(parts));
  return total;
}

/* ------------------------------------------------------------ mini CDP */
async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  return {
    send(method, params) {
      const mid = ++id;
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close() { try { ws.close(); } catch { } },
  };
}

async function waitForTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no CDP page target appeared');
}

/* ---------------------------------------------------------- static server */
function serve(extraRoutes, port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = extraRoutes[url.pathname];
    if (route) return route(req, res);

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(appDir, rel));
    if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('nope');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================ phase 1 */
console.log(`[cam] phase 1 — rendering ${FRAMES} barcode frames (mode ${MODE}, ${SIZE}B payload)`);
const frameData = [];
let phase1Done = false;

const p1 = await serve({
  '/__enc': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(here, 'encode-frames.html')));
  },
  '/frame': (req, res) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => {
      frameData.push({ buf: Buffer.concat(c), w: parseInt(req.headers['x-w'], 10), h: parseInt(req.headers['x-h'], 10) });
      res.writeHead(200); res.end('ok');
    });
  },
  '/done': (req, res) => { req.on('end', () => { }); req.resume(); res.writeHead(200); res.end('ok'); phase1Done = true; },
  '/error': (req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { console.error('[cam] encoder page error:\n' + Buffer.concat(c)); res.writeHead(200); res.end('ok'); phase1Done = true; }); },
});

const prof1 = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-cam1-'));
const chrome1 = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions', '--mute-audio',
  `--user-data-dir=${prof1}`,
  `http://127.0.0.1:${p1.port}/__enc?mode=${MODE}&size=${SIZE}&frames=${FRAMES}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome1.stderr.on('data', () => { });

for (let i = 0; i < 200 && !phase1Done; i++) await sleep(250);
chrome1.kill('SIGKILL');
p1.server.close();

if (!frameData.length) { console.error('❌ phase 1 produced no frames'); process.exit(1); }

const CW = frameData[0].w, CH = frameData[0].h;
/* must match what the app asks getUserMedia for in portrait with captureMax=1280 */
const CAM_W = parseInt(arg('camw', '960'), 10);
const CAM_H = parseInt(arg('camh', '960'), 10);
/* keep the barcode inset with margin: Chrome rescales the file to the
   constraints the page requests, and a code flush to the edge loses its
   corner anchors when that happens */
const camFrames = composeCameraFrames(frameData.map((f) => f.buf), CW, CH, CAM_W, CAM_H, parseFloat(arg('coverage', '0.8')));
const y4m = path.join(os.tmpdir(), `aircimbar-${Date.now()}.y4m`);
const totalFrames = writeY4M(y4m, camFrames, CAM_W, CAM_H, REPEAT);
console.log(`[cam] barcode ${CW}x${CH} -> camera view ${CAM_W}x${CAM_H}, ${totalFrames} Y4M frames -> ${y4m}`);

/* ================================================================ phase 2 */
console.log('[cam] phase 2 — driving the real receiver UI against a fake camera');

const p2 = await serve({});

const prof2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-cam2-'));
const dbgPort = 9500 + Math.floor(Math.random() * 400);
const chrome2 = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions', '--mute-audio',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-video-capture=${y4m}`,
  `--remote-debugging-port=${dbgPort}`,
  `--user-data-dir=${prof2}`,
  `http://127.0.0.1:${p2.port}/?tab=receive`,
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chrome2Log = '';
chrome2.stderr.on('data', (d) => { chrome2Log += d; });

let out = null;
try {
  const wsUrl = await waitForTarget(dbgPort);
  const cdp = await cdpSession(wsUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* the target appears before the document finishes loading, and an evaluate
     issued too early is killed when the context is torn down — wait for a
     settled document and retry if it still races */
  async function readyState() {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      return r.result && r.result.value;
    } catch { return null; }
  }
  for (let i = 0; i < 80; i++) {
    if (await readyState() === 'complete') break;
    await sleep(150);
  }

  const expr = `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // Runtime.evaluate can land before ui.js has finished; wait for the app
    for (let i = 0; i < 120; i++) {
      if (window.AirCimbarReceiver && document.getElementById('btnScan')) break;
      await sleep(100);
    }
    const R = window.AirCimbarReceiver;
    if (!R) return { fatal: 'AirCimbarReceiver missing after 12s' };
    const result = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ timeout: true, st: R.state }), 110000);
      R.on('complete', async (info) => {
        clearTimeout(t);
        const buf = new Uint8Array(await info.blob.arrayBuffer());
        const h = await crypto.subtle.digest('SHA-256', buf);
        resolve({
          name: info.name, size: info.size,
          sha: [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join(''),
          scanOk: R.state.scanOk, scanFail: R.state.scanFail, dispatched: R.state.dispatched,
          lockedMode: R.state.lockedMode,
        });
      });
      document.getElementById('btnScan').click();
    });
    return result;
  })()`;

  for (let attempt = 1; attempt <= 3 && !out; attempt++) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      out = r.result && r.result.value;
      if (!out && r.exceptionDetails) console.error('[cam] page exception:', JSON.stringify(r.exceptionDetails).slice(0, 600));
    } catch (e) {
      console.error(`[cam] evaluate attempt ${attempt} failed: ${e.message}`);
      await sleep(2500);
    }
  }
  cdp.close();
} catch (e) {
  console.error('[cam] CDP failure:', e.message);
}

chrome2.kill('SIGKILL');
p2.server.close();
try { fs.unlinkSync(y4m); } catch { }

/* ================================================================ verdict */
if (!out) {
  console.error('❌ no result from the receiver page');
  console.error(chrome2Log.split('\n').filter((l) => !/crashpad|cv_display_link|keychain|SecItemCopyMatching|password_store|Encryption|gl_utils|Fontconfig/.test(l)).slice(-15).join('\n'));
  process.exit(1);
}
if (out.fatal) { console.error('❌ ' + out.fatal); process.exit(1); }

if (out.timeout) {
  console.error('❌ receiver never completed.');
  console.error(`   dispatched=${out.st.dispatched} scanOk=${out.st.scanOk} scanFail=${out.st.scanFail} nodata=${out.st.scanNodata} progress=${out.st.progress}`);
  process.exit(1);
}

const crypto = await import('node:crypto');
const expected = crypto.createHash('sha256').update(payload).digest('hex');

console.log(`[cam] receiver: dispatched=${out.dispatched} hit=${out.scanOk} miss=${out.scanFail} lockedMode=${out.lockedMode}`);
console.log(`[cam] file="${out.name}" size=${out.size}B`);
console.log(`[cam] expected sha256 = ${expected}`);
console.log(`[cam] actual   sha256 = ${out.sha}`);

const ok = out.size === payload.length && out.sha === expected;
console.log('');
console.log(ok
  ? `✅ CAMERA PATH OK — fake camera -> recv.js -> ${out.size}B byte-identical (mode ${MODE})`
  : '❌ CAMERA PATH FAILED');
process.exit(ok ? 0 : 1);
