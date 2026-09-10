#!/usr/bin/env node
/**
 * AirCimbar app-level integration test.
 *
 * Serves the real ./app directory to headless Chrome and loads a page that
 * exercises the shipped modules end to end:
 *
 *   app/js/cimbar.js + app/js/send.js   -> encode & render the barcode
 *   app/js/cimbar-worker.js (scan/sink) -> decode & reassemble the file
 *
 * Only the camera capture loop in recv.js is stubbed out.
 *
 *   node test/app-roundtrip.mjs [--mode 68] [--size 8192] [--frames 24]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const appDir = path.join(root, 'app');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MODE = arg('mode', '68');
const SIZE = arg('size', '8192');
const FRAMES = arg('frames', '24');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

let result = null;
let finish;
const finished = new Promise((r) => { finish = r; });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/result') {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => {
      try { result = JSON.parse(Buffer.concat(c).toString()); } catch (e) { result = { fatal: 'bad json' }; }
      res.writeHead(200); res.end('ok');
      finish();
    });
    return;
  }

  if (url.pathname === '/__test') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(here, 'app-roundtrip.html')));
  }

  // serve the real app
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(appDir, rel);
  if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
console.log(`[app-test] serving ./app on http://127.0.0.1:${port}  (mode=${MODE}, size=${SIZE}B, frames=${FRAMES})`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-app-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--disable-extensions',
  `--user-data-dir=${profile}`,
  `http://127.0.0.1:${port}/__test?mode=${MODE}&size=${SIZE}&frames=${FRAMES}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeLog = '';
chrome.stdout.on('data', (d) => { chromeLog += d; });
chrome.stderr.on('data', (d) => { chromeLog += d; });

const to = setTimeout(() => { console.error('[app-test] TIMEOUT (150s)'); finish(); }, 150000);
await finished;
clearTimeout(to);
chrome.kill('SIGKILL');
server.close();

if (!result) {
  console.error('❌ page never reported a result');
  console.error(chromeLog.split('\n').filter(l => !/crashpad|cv_display_link|keychain|SecItemCopyMatching|password_store|Encryption is not|gl_utils/.test(l)).slice(-20).join('\n'));
  process.exit(1);
}
if (result.fatal) {
  console.error('❌ page error:\n' + result.fatal);
  process.exit(1);
}

console.log(`[app-test] rendered ${result.frames} frames @ ${result.frameW}x${result.frameH}`);
console.log(`[app-test] scan: hit=${result.scanOk} miss=${result.scanFail}`);
console.log(`[app-test] output name="${result.outName}" size=${result.outLen}B`);
console.log(`[app-test] expected sha256 = ${result.payloadSha}`);
console.log(`[app-test] actual   sha256 = ${result.outSha}`);

const ok = result.completed && result.outLen === result.payloadLen && result.outSha === result.payloadSha;
console.log('');
console.log(ok
  ? `✅ APP ROUND TRIP OK — ${result.frames} frames, ${result.outLen}B byte-identical (mode ${MODE})`
  : `❌ APP ROUND TRIP FAILED`);
process.exit(ok ? 0 : 1);
