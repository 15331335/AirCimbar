#!/usr/bin/env node
/**
 * Regression test: changing mode / compression while broadcasting.
 *
 * Before the fix this aborted the broadcast with "next_frame 失败 (-1)",
 * because cimbare_configure() discards the encoder stream (cimbar_js.cpp:
 * `_fes = nullptr`) when the payload no longer fills a chunk under the new
 * settings, and _cimbare_next_frame() returns -1 while that is true.
 *
 * Asserts:
 *   * no error event fires while the settings are being applied
 *   * the broadcast keeps running afterwards
 *   * frames produced after the switch still decode (the stream was rebuilt
 *     correctly, not just silently restarted)
 *
 *   node test/reconfigure.mjs
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

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => { console.error('[recfg] watchdog'); try { spawn('pkill', ['-f', 'aircimbar-rec']); } catch { } process.exit(2); }, 300000);

function makePayload(n) {
  const b = new Uint8Array(n); let s = 0x12345678;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s >>> 16) & 0xff; }
  return b;
}
const payload = makePayload(8192);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

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

const frames = [];
let report = null;
let finish;
const finished = new Promise((r) => { finish = r; });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__test') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(here, 'reconfigure.html')));
  }
  if (req.method === 'POST' && url.pathname === '/frame') {
    const c = []; req.on('data', (d) => c.push(d));
    req.on('end', () => { frames.push({ buf: Buffer.concat(c), w: +req.headers['x-w'], h: +req.headers['x-h'] }); res.writeHead(200); res.end('ok'); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/done') {
    const c = []; req.on('data', (d) => c.push(d));
    req.on('end', () => { try { report = JSON.parse(Buffer.concat(c).toString()); } catch { report = {}; } res.writeHead(200); res.end('ok'); finish(); });
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(appDir, rel));
  if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
console.log(`[recfg] serving app on http://127.0.0.1:${port}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-rec-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions',
  `--user-data-dir=${profile}`,
  `http://127.0.0.1:${port}/__test`,
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (d) => { chromeLog += d; });

const to = setTimeout(() => { console.error('[recfg] TIMEOUT'); finish(); }, 240000);
await finished;
clearTimeout(to);
chrome.kill('SIGKILL');
server.close();

const problems = [];
if (!report) {
  console.error('❌ the page never reported back');
  console.error(chromeLog.split('\n').filter((l) => !/crashpad|cv_display_link|keychain|SecItemCopyMatching|password_store|Encryption|gl_utils|Fontconfig/.test(l)).slice(-15).join('\n'));
  process.exit(1);
}
if (report.fatal) { console.error('❌ page error:\n' + report.fatal); process.exit(1); }

console.log(`[recfg] 阶段1 (Bu) 渲染 ${report.beforeCount} 帧`);
console.log(`[recfg] 改压缩等级后仍在运行: ${report.stillRunningAfterCompressionChange}`);
console.log(`[recfg] 阶段2 (切到 B) 渲染 ${report.afterCount} 帧`);
console.log(`[recfg] 进入重配置状态次数: ${report.reconfiguringEvents}`);
console.log(`[recfg] 捕获到的 error 事件: ${report.errors.length ? JSON.stringify(report.errors) : '无'}`);

if (report.errors.length) problems.push('广播中切换设置触发了 error 事件: ' + report.errors.join(' | '));
if (!report.stillRunningAfterCompressionChange) problems.push('改压缩等级后广播停止了');
if (report.beforeCount < 2) problems.push('阶段1 帧数过少 (' + report.beforeCount + ')');
if (report.afterCount < 2) problems.push('切换模式后没有继续出帧 (' + report.afterCount + ')');
if (report.reconfiguringEvents < 2) problems.push('reconfiguring 事件未按预期触发 (' + report.reconfiguringEvents + ')');

// the post-switch frames must still decode — proving the stream was rebuilt properly
if (frames.length) {
  const M = await loadWasm();
  M._cimbard_configure_decode(68);
  const fsize = M._cimbard_get_bufsize();
  const fptr = M._malloc(fsize);
  let hits = 0, completed = false;
  for (const f of frames) {
    const p = M._malloc(f.buf.length);
    new Uint8Array(M.HEAPU8.buffer, p, f.buf.length).set(f.buf);
    const len = M._cimbard_scan_extract_decode(p, f.w, f.h, 4, fptr, fsize);
    M._free(p);
    if (len > 0) { hits++; if (M._cimbard_fountain_decode(fptr, len) > 0) completed = true; }
  }
  M._free(fptr);
  console.log(`[recfg] 切换后的帧解码: 命中 ${hits}/${frames.length}, 完整还原=${completed}`);
  if (!completed) problems.push('切换模式后产出的帧无法还原文件（流没有被正确重建）');
} else {
  problems.push('切换后没有收到任何帧');
}

clearTimeout(watchdog);
console.log('');
if (problems.length) {
  console.error('❌ 重配置回归测试失败:');
  for (const p of problems) console.error('   • ' + p);
  process.exit(1);
}
console.log('✅ 重配置回归测试通过 — 广播中切换帧率/压缩/模式不再中断，且重建后的码流仍可解码');
process.exit(0);
