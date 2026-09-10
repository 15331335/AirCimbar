#!/usr/bin/env node
/**
 * AirCimbar round-trip verification harness.
 *
 *   Chrome (headless, WebGL/SwiftShader)  ->  encodes with the official
 *   libcimbar wasm encoder, snapshots every rendered frame as top-down RGBA,
 *   POSTs them here.
 *
 *   Node                                  ->  decodes those exact frames with
 *   the official libcimbar wasm *decoder* (pure CPU, no GL needed) and checks
 *   the reassembled file is byte-identical to the original.
 *
 * This exercises the same engine the PWA uses, end to end.
 *
 *   node test/roundtrip.mjs [--mode 68] [--size 8192] [--frames 40] [--keep]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const vendorDir = path.join(root, 'app', 'vendor');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const MODE = parseInt(arg('mode', '68'), 10);
const SIZE = parseInt(arg('size', '8192'), 10);
const FRAMES = parseInt(arg('frames', '40'), 10);
const KEEP = argv.includes('--keep');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const glueName = fs.readdirSync(vendorDir).find((f) => /^cimbar_js(\.|_).*\.js$/.test(f) || f === 'cimbar_js.js');
if (!glueName) { console.error('no vendored cimbar_js glue found'); process.exit(1); }

// ---------------------------------------------------------------- payload
function makePayload(n) {
  const b = new Uint8Array(n);
  let s = 0x12345678;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s >>> 16) & 0xff; }
  return b;
}
const payload = makePayload(SIZE);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

// ---------------------------------------------------------------- wasm decoder
function loadWasm() {
  const glue = path.join(vendorDir, glueName);
  const sandbox = {
    Module: {
      print: () => {}, printErr: () => {},
      locateFile: (p) => path.join(vendorDir, /\.wasm$/.test(p) ? 'cimbar_js.wasm' : p),
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    process, require, __filename: glue, __dirname: vendorDir,
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder, performance, fetch, WebAssembly, URL, Buffer,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const ready = new Promise((res, rej) => {
    sandbox.Module.onRuntimeInitialized = () => res(sandbox.Module);
    setTimeout(() => rej(new Error('wasm init timeout')), 20000);
  });
  vm.runInContext(fs.readFileSync(glue, 'utf8'), sandbox, { filename: glue });
  return ready;
}

// ---------------------------------------------------------------- http harness
const frames = [];
let doneInfo = null;
let pageError = null;
let finish;
const finished = new Promise((r) => { finish = r; });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    let html = fs.readFileSync(path.join(here, 'roundtrip.html'), 'utf8');
    html = html.replace('/vendor/GLUE', '/vendor/' + glueName);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
    const f = path.join(vendorDir, path.basename(url.pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
    return res.end(fs.readFileSync(f));
  }

  if (req.method === 'POST' && url.pathname === '/progress') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { console.log('  [page] ' + Buffer.concat(chunks).toString()); res.writeHead(200); res.end('ok'); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/frame') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      frames.push({
        buf: Buffer.concat(chunks),
        w: parseInt(req.headers['x-w'], 10),
        h: parseInt(req.headers['x-h'], 10),
        i: parseInt(req.headers['x-i'], 10),
      });
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/done') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { doneInfo = JSON.parse(Buffer.concat(chunks).toString()); } catch { doneInfo = { raw: true }; }
      res.writeHead(200); res.end('ok');
      finish();
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/error') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { pageError = Buffer.concat(chunks).toString(); res.writeHead(200); res.end('ok'); finish(); });
    return;
  }

  res.writeHead(404); res.end();
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
console.log(`[harness] serving on http://127.0.0.1:${port}  (mode=${MODE}, size=${SIZE}B, maxFrames=${FRAMES})`);

// ---------------------------------------------------------------- run chrome
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--disable-extensions',
  `--user-data-dir=${profile}`,
  `http://127.0.0.1:${port}/?mode=${MODE}&size=${SIZE}&frames=${FRAMES}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeLog = '';
chrome.stdout.on('data', (d) => { chromeLog += d; });
chrome.stderr.on('data', (d) => { chromeLog += d; });

const timeout = setTimeout(() => { console.error('[harness] TIMEOUT (90s) waiting for Chrome to finish'); finish(); }, 90000);
await finished;
clearTimeout(timeout);
chrome.kill('SIGKILL');

// ---------------------------------------------------------------- decode
let failed = false;
const say = (m) => console.log(m);

if (pageError) {
  console.error('\n❌ page reported an error:\n' + pageError);
  failed = true;
}

say(`\n[harness] received ${frames.length} frames`);
if (frames.length === 0) {
  console.error('❌ no frames captured. Chrome log tail:\n' + chromeLog.split('\n').slice(-25).join('\n'));
  process.exit(1);
}

const M = await loadWasm();
M._cimbard_configure_decode(MODE);
const fountSize = M._cimbard_get_bufsize();
const fountPtr = M._malloc(fountSize);
say(`[decode] mode=${MODE} fountain bufsize=${fountSize}`);

let decodedId = 0;
let scanOk = 0, scanNoData = 0, scanFail = 0;
const reportPtr = M._malloc(1024);

for (const fr of frames) {
  const imgPtr = M._malloc(fr.buf.length);
  new Uint8Array(M.HEAPU8.buffer, imgPtr, fr.buf.length).set(fr.buf);
  const len = M._cimbard_scan_extract_decode(imgPtr, fr.w, fr.h, 4, fountPtr, fountSize);
  M._free(imgPtr);

  if (len <= 0) {
    if (len === 0) scanNoData++; else scanFail++;
    if (len !== 0) {
      const n = M._cimbard_get_report(reportPtr, 1024);
      const msg = n > 0 ? new TextDecoder().decode(new Uint8Array(M.HEAPU8.buffer, reportPtr, n)) : '';
      if (scanFail <= 3) say(`  frame ${fr.i}: extract failed (${len}) ${msg}`);
    }
    continue;
  }
  scanOk++;
  const id = M._cimbard_fountain_decode(fountPtr, len);
  // int64_t arrives as a BigInt (WASM_BIGINT=1); the real id is a uint32_t
  if (id > 0) { decodedId = Number(BigInt.asUintN(32, id)); say(`  frame ${fr.i}: ★ COMPLETE (id=${decodedId})`); break; }
  if (scanOk % 10 === 0) say(`  frame ${fr.i}: decoded ${len}B fountain data (${scanOk} ok so far)`);
}
M._free(reportPtr);
M._free(fountPtr);

say(`[decode] scan results: ok=${scanOk} nodata=${scanNoData} failed=${scanFail}`);

if (!decodedId) {
  console.error('❌ file never completed — fountain decoder did not assemble');
  if (KEEP) { fs.writeFileSync('/tmp/aircimbar-frames.txt', frames.map(f => `${f.i} ${f.w}x${f.h} ${f.buf.length}`).join('\n')); }
  process.exit(1);
}

// filename
const fnPtr = M._malloc(1024);
const fnLen = M._cimbard_get_filename(decodedId, fnPtr, 1024);
const filename = fnLen > 0 ? new TextDecoder().decode(new Uint8Array(M.HEAPU8.buffer, fnPtr, fnLen)) : '(unknown)';
M._free(fnPtr);

// decompressed contents (streamed)
const chunkSize = M._cimbard_get_decompress_bufsize();
const dPtr = M._malloc(chunkSize);
const parts = [];
for (;;) {
  const n = M._cimbard_decompress_read(decodedId, dPtr, chunkSize);
  if (n <= 0) break;
  parts.push(Buffer.from(new Uint8Array(M.HEAPU8.buffer, dPtr, n)));
}
M._free(dPtr);

const out = Buffer.concat(parts);
const outSha = crypto.createHash('sha256').update(out).digest('hex');

say(`[decode] filename="${filename}"  size=${out.length}B`);
say(`[decode] expected sha256 = ${payloadSha}`);
say(`[decode] actual   sha256 = ${outSha}`);

const ok = out.length === payload.length && outSha === payloadSha;
say('');
say(ok
  ? `✅ ROUND TRIP OK — ${frames.length} frames transmitted, ${out.length}B reconstructed byte-identical (mode ${MODE})`
  : `❌ MISMATCH — expected ${payload.length}B/${payloadSha.slice(0, 16)}… got ${out.length}B/${outSha.slice(0, 16)}…`);

server.close();
process.exit(ok ? 0 : 1);
