#!/usr/bin/env node
/**
 * Camera capture-path probe.
 *
 * The composed camera image decodes fine in Node, so the fault is in how the
 * app turns a camera frame into wasm input. This captures ONE camera frame
 * two ways — canvas RGBA, and the native VideoFrame format the app prefers —
 * and decodes each with the matching wasm format code.
 *
 *   node test/camera-probe.mjs [--mode 68] [--size 4096]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const appDir = path.join(root, 'app');
const vendorDir = path.join(appDir, 'vendor');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MODE = parseInt(arg('mode', '68'), 10);
const SIZE = parseInt(arg('size', '4096'), 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => { console.error('[probe] watchdog'); try { spawn('pkill', ['-f', 'aircimbar-probe']); } catch { } process.exit(2); }, 150000);

/* ------------------------------------------------------------- rendering */
function makePayload(n) {
  const b = new Uint8Array(n); let s = 0x12345678;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s >>> 16) & 0xff; }
  return b;
}
function composeCameraFrames(codeFrames, cw, ch, outW, outH, coverage) {
  const box = Math.round(Math.min(outW, outH) * coverage);
  const ox = Math.round((outW - box) / 2), oy = Math.round((outH - box) / 2);
  return codeFrames.map((code) => {
    const out = Buffer.alloc(outW * outH * 4);
    for (let i = 0; i < out.length; i += 4) { out[i] = 26; out[i + 1] = 28; out[i + 2] = 34; out[i + 3] = 255; }
    for (let y = 0; y < box; y++) {
      const sy = Math.min(ch - 1, Math.floor(y * ch / box));
      for (let x = 0; x < box; x++) {
        const sx = Math.min(cw - 1, Math.floor(x * cw / box));
        const si = (sy * cw + sx) * 4, di = ((oy + y) * outW + (ox + x)) * 4;
        out[di] = code[si]; out[di + 1] = code[si + 1]; out[di + 2] = code[si + 2]; out[di + 3] = 255;
      }
    }
    return out;
  });
}
function rgbaToI420(rgba, w, h, out, off) {
  const ySize = w * h, cSize = (w >> 1) * (h >> 1);
  let yo = off, uo = off + ySize, vo = off + ySize + cSize;
  const cl = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    out[yo++] = cl(0.257 * rgba[i] + 0.504 * rgba[i + 1] + 0.098 * rgba[i + 2] + 16);
  }
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    let rs = 0, gs = 0, bs = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      rs += rgba[i]; gs += rgba[i + 1]; bs += rgba[i + 2];
    }
    const r = rs / 4, g = gs / 4, b = bs / 4;
    const ci = (y >> 1) * (w >> 1) + (x >> 1);
    out[uo + ci] = cl(-0.148 * r - 0.291 * g + 0.439 * b + 128);
    out[vo + ci] = cl(0.439 * r - 0.368 * g - 0.071 * b + 128);
  }
}
function writeY4M(file, frames, w, h, repeat) {
  const ySize = w * h, cSize = (w >> 1) * (h >> 1), frameLen = ySize + 2 * cSize;
  const buf = Buffer.alloc(frames.length * repeat * frameLen);
  let off = 0;
  for (let r = 0; r < repeat; r++) for (const f of frames) { rgbaToI420(f, w, h, buf, off); off += frameLen; }
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420mpeg2\n`, 'ascii')];
  const tag = Buffer.from('FRAME\n', 'ascii');
  for (let i = 0; i < frames.length * repeat; i++) parts.push(tag, buf.subarray(i * frameLen, (i + 1) * frameLen));
  fs.writeFileSync(file, Buffer.concat(parts));
  return frames.length * repeat;
}

/* ------------------------------------------------------------------ wasm */
function loadWasm() {
  const glue = path.join(vendorDir, 'cimbar_js.js');
  const sb = {
    Module: { print() { }, printErr() { }, locateFile: (p) => path.join(vendorDir, /\.wasm$/.test(p) ? 'cimbar_js.wasm' : p) },
    console: { log() { }, warn() { }, error() { }, info() { } },
    process, require, __filename: glue, __dirname: vendorDir,
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder, performance, fetch, WebAssembly, URL, Buffer,
  };
  sb.globalThis = sb; sb.self = sb;
  vm.createContext(sb);
  const ready = new Promise((res, rej) => {
    sb.Module.onRuntimeInitialized = () => res(sb.Module);
    setTimeout(() => rej(new Error('wasm timeout')), 20000);
  });
  vm.runInContext(fs.readFileSync(glue, 'utf8'), sb, { filename: glue });
  return ready;
}

function tryDecode(M, buf, w, h, format, mode) {
  M._cimbard_configure_decode(mode);
  const fsize = M._cimbard_get_bufsize();
  const fptr = M._malloc(fsize);
  const p = M._malloc(buf.length);
  new Uint8Array(M.HEAPU8.buffer, p, buf.length).set(buf);
  const len = M._cimbard_scan_extract_decode(p, w, h, format, fptr, fsize);
  M._free(p);
  let report = '';
  if (len !== 0) {
    const rp = M._malloc(2048);
    const n = M._cimbard_get_report(rp, 2048);
    if (n > 0) report = new TextDecoder().decode(new Uint8Array(M.HEAPU8.buffer, rp, n));
    M._free(rp);
  }
  M._free(fptr);
  return { len, report: report.slice(0, 300) };
}

/* ------------------------------------------------------------------- cdp */
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
async function waitForTarget(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
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

/* ============================================== render + build fake camera */
console.log(`[probe] rendering barcode frames (mode ${MODE}, ${SIZE}B)`);
const frames = [];
let rendered = false;
const s1 = await serve({
  '/__enc': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(path.join(here, 'encode-frames.html'))); },
  '/frame': (req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { frames.push({ buf: Buffer.concat(c), w: +req.headers['x-w'], h: +req.headers['x-h'] }); res.writeHead(200); res.end('ok'); }); },
  '/done': (req, res) => { req.resume(); res.writeHead(200); res.end('ok'); rendered = true; },
  '/error': (req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { console.error('encoder page: ' + Buffer.concat(c)); res.writeHead(200); res.end('ok'); rendered = true; }); },
});
const prof1 = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-probe1-'));
const c1 = spawn(CHROME, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions', `--user-data-dir=${prof1}`,
  `http://127.0.0.1:${s1.port}/__enc?mode=${MODE}&size=${SIZE}&frames=8`], { stdio: ['ignore', 'pipe', 'pipe'] });
c1.stderr.on('data', () => { });
for (let i = 0; i < 240 && !rendered; i++) await sleep(250);
c1.kill('SIGKILL'); s1.server.close();
if (!frames.length) { console.error('no frames rendered'); process.exit(1); }

const CW = frames[0].w, CH = frames[0].h;
const CAM_W = 960, CAM_H = 1280;
const camFrames = composeCameraFrames(frames.map(f => f.buf), CW, CH, CAM_W, CAM_H, 0.9);
const y4m = path.join(os.tmpdir(), `aircimbar-probe-${Date.now()}.y4m`);
const n = writeY4M(y4m, camFrames, CAM_W, CAM_H, 4);
console.log(`[probe] camera view ${CAM_W}x${CAM_H}, ${n} Y4M frames`);

/* =================================================== pull frames from page */
let dumped = {};
const s2 = await serve({
  '/dump': (req, res) => {
    const c = []; req.on('data', d => c.push(d));
    req.on('end', () => { dumped[req.headers['x-kind']] = Buffer.concat(c); res.writeHead(200); res.end('ok'); });
  },
});
const prof2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-probe2-'));
const dbgPort = 9900 + Math.floor(Math.random() * 90);
const c2 = spawn(CHROME, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-video-capture=${y4m}`,
  `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${prof2}`,
  `http://127.0.0.1:${s2.port}/?tab=receive`], { stdio: ['ignore', 'pipe', 'pipe'] });
c2.stderr.on('data', () => { });

let info = null;
try {
  const ws = await waitForTarget(dbgPort);
  const cdp = await cdpSession(ws);
  await cdp.send('Runtime.enable');
  const expr = `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // wait for the app to finish loading -- the deep-link tab switch is deferred
    for (let i = 0; i < 100; i++) {
      if (window.AirCimbarReceiver && document.getElementById('btnScan')) break;
      await sleep(100);
    }
    if (!window.AirCimbarReceiver) return JSON.stringify({ error: 'app not loaded' });

    document.getElementById('btnScan').click();
    const v = document.getElementById('recvVideo');
    for (let i = 0; i < 120; i++) { if (v.videoWidth) break; await sleep(100); }
    if (!v.videoWidth) return JSON.stringify({ error: 'no camera stream', srcObject: !!v.srcObject, rs: v.readyState });
    await sleep(2500);

    const out = { videoW: v.videoWidth, videoH: v.videoHeight, vfFormat: null, alloc: 0, allocRGBA: 0 };

    // path A: canvas -> RGBA (what the app falls back to)
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    await fetch('/dump', { method: 'POST', body: new Uint8Array(d.data.buffer), headers: { 'x-kind': 'rgba' } });

    // path B: native VideoFrame (what the app prefers)
    try {
      const vf = new VideoFrame(v, { timestamp: 0 });
      out.vfFormat = vf.format;
      out.alloc = vf.allocationSize();
      out.allocRGBA = vf.allocationSize({ format: 'RGBA' });
      const fmt = (vf.format === 'NV12' || vf.format === 'I420') ? vf.format : 'RGBA';
      const size = vf.allocationSize({ format: fmt });
      const buf = new Uint8Array(size);
      vf.copyTo(buf, { format: fmt });
      vf.close();
      out.copiedFormat = fmt;
      out.copiedSize = size;
      await fetch('/dump', { method: 'POST', body: buf, headers: { 'x-kind': 'native' } });
    } catch (e) { out.vfError = String(e); }

    return JSON.stringify(out);
  })()`;
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const raw = r.result && r.result.value;
  info = typeof raw === 'string' ? JSON.parse(raw) : null;
  if (!info && r.exceptionDetails) console.error('[probe] exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  cdp.close();
} catch (e) { console.error('[probe] cdp error: ' + e.message); }
c2.kill('SIGKILL'); s2.server.close();
try { fs.unlinkSync(y4m); } catch { }

console.log('[probe] page info: ' + JSON.stringify(info));
if (!info || info.error) { clearTimeout(watchdog); process.exit(1); }

const M = await loadWasm();

console.log('');
console.log(`  video           ${info.videoW}x${info.videoH}`);
console.log(`  VideoFrame.fmt  ${info.vfFormat}   alloc=${info.alloc} allocRGBA=${info.allocRGBA}`);
const ySize = info.videoW * info.videoH;
console.log(`  expected NV12   ${Math.round(ySize * 1.5)}  (alloc - expected = ${info.alloc - Math.round(ySize * 1.5)} padding bytes)`);
console.log(`  expected RGBA   ${ySize * 4}`);

if (dumped.rgba) {
  console.log(`\n  A) canvas RGBA  ${dumped.rgba.length}B -> format 4`);
  const r = tryDecode(M, dumped.rgba, info.videoW, info.videoH, 4, MODE);
  console.log(`     len=${r.len} ${r.len > 0 ? '✅ DECODED' : '❌ failed'}  report=${r.report}`);
}
if (dumped.native) {
  const fcode = info.copiedFormat === 'NV12' ? 12 : info.copiedFormat === 'I420' ? 420 : 4;
  const w = info.copiedFormat === 'RGBA' ? info.videoW : info.videoW;
  console.log(`\n  B) native ${info.copiedFormat} ${dumped.native.length}B -> format ${fcode}`);
  const r = tryDecode(M, dumped.native, w, info.videoH, fcode, MODE);
  console.log(`     len=${r.len} ${r.len > 0 ? '✅ DECODED' : '❌ failed'}  report=${r.report}`);
}
console.log('');
clearTimeout(watchdog);
process.exit(0);
