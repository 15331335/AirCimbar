#!/usr/bin/env node
/**
 * How dense can a cimbar code get before it stops decoding?
 *
 * Renders real barcode frames with the app's encoder, then resamples them down
 * to progressively fewer pixels across the code and tries to decode each one.
 * The smallest width that still reconstructs the file is the practical pixel
 * budget for that mode — which is what decides whether a phone-to-phone
 * transfer can work at all.
 *
 *   node test/resolution.mjs [--sizes 1024,864,720,600,512,432,360,300]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import crypto from 'node:crypto';
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
const SIZES = arg('sizes', '1024,864,720,600,512,432,360,300,240').split(',').map(Number);
const PAYLOAD = 4096;
const FRAMES = 14;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => { console.error('[res] watchdog'); try { spawn('pkill', ['-f', 'aircimbar-res']); } catch { } process.exit(2); }, 900000);

function makePayload(n) {
  const b = new Uint8Array(n); let s = 0x12345678;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s >>> 16) & 0xff; }
  return b;
}
const payload = makePayload(PAYLOAD);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

/* Bilinear resample with a sub-pixel phase offset.
   The phase matters: a box filter aligned one way can accidentally destroy the
   9px cell grid while a different alignment keeps it, which produces the fake
   "works at 360 but not at 432" results a single phase gives you. Sampling
   several phases and averaging is what makes the curve trustworthy. */
function downscale(src, sw, sh, dw, dh, phaseX = 0, phaseY = 0, blur = 0.0) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  const sample = (fx, fy, ch) => {
    const x = Math.min(sw - 1.001, Math.max(0, fx));
    const y = Math.min(sh - 1.001, Math.max(0, fy));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = x - x0, ty = y - y0;
    const i00 = (y0 * sw + x0) * 4 + ch, i10 = (y0 * sw + x0 + 1) * 4 + ch;
    const i01 = ((y0 + 1) * sw + x0) * 4 + ch, i11 = ((y0 + 1) * sw + x0 + 1) * 4 + ch;
    return (src[i00] * (1 - tx) + src[i10] * tx) * (1 - ty) +
           (src[i01] * (1 - tx) + src[i11] * tx) * ty;
  };
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      // sample the centre of the destination pixel, with the phase offset and
      // an optional small box to soften it like a lens would
      const cx = (x + 0.5 + phaseX) * xr, cy = (y + 0.5 + phaseY) * yr;
      const o = (y * dw + x) * 4;
      if (blur <= 0) {
        for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.round(sample(cx - 0.5, cy - 0.5, ch));
      } else {
        for (let ch = 0; ch < 3; ch++) {
          let acc = 0, n = 0;
          for (let dy = -blur; dy <= blur; dy += blur) {
            for (let dx = -blur; dx <= blur; dx += blur) { acc += sample(cx - 0.5 + dx, cy - 0.5 + dy, ch); n++; }
          }
          out[o + ch] = Math.round(acc / n);
        }
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

const PHASES = [[0, 0], [0.34, 0.17], [0.67, 0.5]];

function loadWasm() {
  const glue = path.join(vendorDir, 'cimbar_js.js');
  const sb = {
    Module: {
      print() { }, printErr() { },
      locateFile: (p) => path.join(vendorDir, /\.wasm$/.test(p) ? 'cimbar_js.wasm' : p),
    },
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

/** Feed every frame so the hit count reflects reliability, not luck at the
    first frame. `done` records whether the file was reconstructed at all. */
function tryDecode(M, frames, w, h, mode) {
  M._cimbard_configure_decode(mode);
  const fsize = M._cimbard_get_bufsize();
  const fptr = M._malloc(fsize);
  let hits = 0;
  let done = false;
  for (const f of frames) {
    const p = M._malloc(f.length);
    new Uint8Array(M.HEAPU8.buffer, p, f.length).set(f);
    const len = M._cimbard_scan_extract_decode(p, w, h, 4, fptr, fsize);
    M._free(p);
    if (len > 0) {
      hits++;
      if (M._cimbard_fountain_decode(fptr, len) > 0) done = true;
    }
  }
  M._free(fptr);
  return { hits, total: frames.length, done };
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

async function renderFrames(mode) {
  const frames = [];
  let done = false;
  const s = await serve({
    '/__enc': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(path.join(here, 'encode-frames.html'))); },
    '/frame': (req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { frames.push({ buf: Buffer.concat(c), w: +req.headers['x-w'], h: +req.headers['x-h'] }); res.writeHead(200); res.end('ok'); }); },
    '/done': (req, res) => { req.resume(); res.writeHead(200); res.end('ok'); done = true; },
    '/error': (req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { console.error('  encoder error: ' + Buffer.concat(c)); res.writeHead(200); res.end('ok'); done = true; }); },
  });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-res-'));
  const c = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${prof}`,
    `http://127.0.0.1:${s.port}/__enc?mode=${mode}&size=${PAYLOAD}&frames=${FRAMES}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  c.stderr.on('data', () => { });
  for (let i = 0; i < 400 && !done; i++) await sleep(250);
  c.kill('SIGKILL'); s.server.close();
  return frames;
}

/* ------------------------------------------------------------------ run */
const MODES = [
  { id: 68, name: 'B  (112×112 格, 1024²)' },
  { id: 67, name: 'Bm (112×78 格, 1024×720)' },
  { id: 66, name: 'Bu (80×69 格, 736×637)' },
];

console.log(`\n每种模式渲染 ${FRAMES} 帧真实码图，然后逐级降采样测试解码下限。`);
console.log(`载荷 ${PAYLOAD} 字节。\n`);

const results = {};
for (const m of MODES) {
  const frames = await renderFrames(m.id);
  if (!frames.length) { console.log(`${m.name}: 渲染失败`); continue; }
  const sw = frames[0].w, sh = frames[0].h;
  const M = await loadWasm();

  const row = [];
  for (const target of SIZES) {
    const dh = Math.round(sh * target / sw);
    let hits = 0, framesSeen = 0, anyDone = false;
    for (const [px, py] of PHASES) {
      const scaled = frames.map(f => downscale(f.buf, sw, sh, target, dh, px, py));
      const r = tryDecode(M, scaled, target, dh, m.id);
      hits += r.hits; framesSeen += r.total;
      if (r.done) anyDone = true;
    }
    row.push({ target, hits, framesSeen, rate: hits / framesSeen, done: anyDone });
  }
  results[m.name] = { sw, sh, row };
}

/* ------------------------------------------------------------------ report */
console.log('每格 = 该码宽下的解码命中率（成功识别出喷泉码数据的帧占比，已在 3 个采样相位上平均）\n');
const header = '模式'.padEnd(26) + SIZES.map(s => String(s).padStart(8)).join('');
console.log(header);
console.log('─'.repeat(header.length));

for (const [name, data] of Object.entries(results)) {
  let line = name.padEnd(24);
  for (const c of data.row) {
    line += ((c.rate * 100).toFixed(0) + '%' + (c.done ? '' : '·')).padStart(8);
  }
  console.log(line);
}
console.log('  (带 · 表示该尺寸下一次都没能完整还原文件)');

console.log('\n结论:');
for (const [name, data] of Object.entries(results)) {
  const cells = name.includes('80×69') ? 80 : 112;
  // the smallest width that still decodes a solid majority of frames
  const good = data.row.filter(c => c.rate >= 0.5 && c.done).map(c => c.target);
  const minOk = good.length ? Math.min(...good) : null;
  const half = data.row.filter(c => c.rate >= 0.25).map(c => c.target);
  const minHalf = half.length ? Math.min(...half) : null;
  const fmt = (w) => w ? `${String(w).padStart(4)}px (${(w / cells).toFixed(2)}px/格)` : '  未达到';
  console.log(`  ${name.padEnd(24)} 稳定可解 ≥ ${fmt(minOk)}   勉强可用 ≥ ${fmt(minHalf)}`);
}

console.log('\n  码宽 = 摄像头画面里码本身占的像素宽度，不是采集分辨率。');
console.log('  手机拍手机时码一般只占画面 30–60%，所以 采集分辨率 × 0.4 大致就是码宽。\n');

clearTimeout(watchdog);
process.exit(0);
