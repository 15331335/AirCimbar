#!/usr/bin/env node
/**
 * Service worker behaviour test.
 *
 * Two things have to be true at once, and they pull in opposite directions:
 *
 *   1. an edit to the app must reach the phone on the very next reload
 *      (network-first for html/css/js)
 *   2. the app must still open with the server switched off
 *      (cache fallback, including the 1.9 MB wasm)
 *
 * The previous cache-first policy passed (2) and failed (1) — which is why
 * every fix needed a manual cache-version bump before the phone saw it.
 *
 *   node test/sw-update.mjs
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
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function restoreMarker() {
  try { fs.writeFileSync(MARKER_FILE, originalSource); } catch { }
}

/* every exit path must put the source file back — this test edits it */
const watchdog = setTimeout(() => {
  console.error('[sw] watchdog');
  restoreMarker();
  try { spawn('pkill', ['-f', 'aircimbar-sw']); } catch { }
  process.exit(2);
}, 300000);
process.on('SIGINT', () => { restoreMarker(); process.exit(130); });
process.on('SIGTERM', () => { restoreMarker(); process.exit(143); });

/* a marker we can flip on disk and then look for in the browser */
const MARKER_FILE = path.join(appDir, 'js', 'cimbar.js');
const originalSource = fs.readFileSync(MARKER_FILE, 'utf8');
const MARKER_A = 'SWTEST_MARKER_ALPHA';
const MARKER_B = 'SWTEST_MARKER_BRAVO';
const problems = [];

function setMarker(marker) {
  const stripped = originalSource.replace(/\n\/\* SWTEST_MARKER_\w+ \*\/\s*$/m, '');
  fs.writeFileSync(MARKER_FILE, stripped + `\n/* ${marker} */\n`);
}

let port = 0;
let server = null;
function startServer() {
  server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(appDir, rel));
    if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => { port = server.address().port; r(); }));
}
function stopServer() { return new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }); }

function serveStatic() {
  return http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(appDir, rel));
    if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
}

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

let chrome = null, cdp = null;
function evaluate(js, timeout = 20000) {
  return cdp.send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true, timeout })
    .then((r) => (r.result ? r.result.value : undefined))
    .catch(() => undefined);
}
async function reloadAndSettle(expectOffline) {
  await cdp.send('Page.reload', { ignoreCache: false });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(400);
    const state = await evaluate("JSON.stringify({ ready: document.readyState, hasApp: !!(window.AirCimbar && window.AirCimbarSender), ctrl: !!navigator.serviceWorker.controller })");
    if (typeof state === 'string') {
      const s = JSON.parse(state);
      if (s.ready === 'complete' && s.hasApp) return s;
    }
  }
  return null;
}

try {
  setMarker(MARKER_A);
  await startServer();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-sw-'));
  const dbgPort = 9400 + Math.floor(Math.random() * 90);
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => { });

  cdp = await cdpSession(await waitForTarget(dbgPort));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* ---- phase 1: first load installs + activates the service worker ---- */
  let state = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    state = await evaluate("JSON.stringify({ ready: document.readyState, hasApp: !!(window.AirCimbar && window.AirCimbarSender), ctrl: !!navigator.serviceWorker.controller })");
    if (typeof state === 'string' && JSON.parse(state).ctrl) break;
  }
  const s1 = state ? JSON.parse(state) : {};
  console.log(`[sw] 首次加载: 就绪=${s1.ready} 应用已载入=${s1.hasApp} SW已接管=${s1.ctrl}`);
  if (!s1.ctrl) problems.push('service worker 没有接管页面');

  // let the install-time precache finish (it pulls the 1.9 MB wasm)
  await sleep(4000);

  const m1 = await evaluate("fetch('/js/cimbar.js').then(r=>r.text()).then(t=>t.includes('SWTEST_MARKER_ALPHA')?'ALPHA':(t.includes('SWTEST_MARKER_BRAVO')?'BRAVO':'none'))");
  console.log(`[sw] 首次加载读到的标记: ${m1}`);
  if (m1 !== 'ALPHA') problems.push('首次加载没有读到 ALPHA 标记 (得到 ' + m1 + ')');

  /* ---- phase 2: edit the app on disk, reload once, expect the new file ---- */
  const wasmBefore = await evaluate("fetch('/vendor/cimbar_js.wasm').then(r=>r.arrayBuffer()).then(b=>b.byteLength)");
  console.log(`[sw] wasm 可读: ${wasmBefore} 字节`);

  setMarker(MARKER_B);
  console.log('[sw] 已修改 app/js/cimbar.js，现在只重载一次…');
  const after = await reloadAndSettle(false);
  if (!after) { problems.push('重载后页面没有恢复正常'); }
  const m2 = await evaluate("fetch('/js/cimbar.js').then(r=>r.text()).then(t=>t.includes('SWTEST_MARKER_BRAVO')?'BRAVO':(t.includes('SWTEST_MARKER_ALPHA')?'ALPHA':'none'))");
  console.log(`[sw] 单次重载后读到的标记: ${m2}`);
  if (m2 !== 'BRAVO') {
    problems.push('改动没有在单次重载后生效（读到 ' + m2 + '）—— network-first 没起作用');
  }

  /* ---- phase 3: switch the server off; the app must still open ---- */
  console.log('[sw] 关闭服务器，测试离线打开…');
  await stopServer();
  await sleep(1500);
  const offline = await reloadAndSettle(true);
  if (!offline) {
    problems.push('服务器关闭后页面无法打开（离线回退失效）');
  } else {
    console.log(`[sw] 离线重载: 就绪=${offline.ready} 应用已载入=${offline.hasApp}`);
    const offMarker = await evaluate("fetch('/js/cimbar.js').then(r=>r.text()).then(t=>t.includes('SWTEST_MARKER_BRAVO')?'BRAVO':'other')");
    console.log(`[sw] 离线时读到的标记: ${offMarker}`);
    if (offMarker !== 'BRAVO') problems.push('离线时脚本内容不对');
    const offWasm = await evaluate("fetch('/vendor/cimbar_js.wasm').then(r=>r.arrayBuffer()).then(b=>b.byteLength)");
    console.log(`[sw] 离线时 wasm 可读: ${offWasm} 字节`);
    if (offWasm !== 1938488) problems.push('离线时 wasm 取不到或大小不对 (' + offWasm + ')');
  }
} catch (e) {
  problems.push('driver failure: ' + e.message);
} finally {
  try { cdp?.close(); } catch { }
  try { chrome?.kill('SIGKILL'); } catch { }
  try { await stopServer(); } catch { }
  restoreMarker();
}

clearTimeout(watchdog);
console.log('');
if (problems.length) {
  console.error('❌ service worker 测试失败:');
  for (const p of problems) console.error('   • ' + p);
  process.exit(1);
}
console.log('✅ service worker 测试通过 — 改动单次重载即生效，服务器关掉后仍能离线打开（含 wasm）');
process.exit(0);
