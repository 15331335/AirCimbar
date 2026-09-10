#!/usr/bin/env node
/**
 * AirCimbar — UI smoke test.
 *
 * Loads the real app in headless Chrome and drives every control, failing on
 * any uncaught exception or console error. It also asserts the DOM wiring that
 * ui.js depends on actually exists, so a renamed id or a typo in a selector
 * cannot ship silently.
 *
 *   node test/ui-smoke.mjs
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => { console.error('[ui] watchdog'); try { spawn('pkill', ['-f', 'aircimbar-ui']); } catch { } process.exit(2); }, 120000);

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(appDir, rel));
  if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) events.push(m);
  };
  return {
    events,
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'aircimbar-ui-'));
const dbgPort = 9800 + Math.floor(Math.random() * 90);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions', '--mute-audio',
  '--window-size=430,932',           // rough iPhone viewport
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${prof}`,
  `http://127.0.0.1:${port}/`,
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (d) => { chromeLog += d; });
chrome.stdout.on('data', (d) => { chromeLog += d; });

const problems = [];
let report = null;
try {
  const cdp = await cdpSession(await waitForTarget(dbgPort));
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  const ready = async () => {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      return r.result && r.result.value;
    } catch { return null; }
  };
  for (let i = 0; i < 80; i++) { if (await ready() === 'complete') break; await sleep(150); }
  await sleep(700);

  const script = `(async () => {
    const problems = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ---- 1. every id ui.js reaches for must exist ----
    const ids = ['statusDot','statusText','toast','stage','qrCanvas','stagePlaceholder',
      'filePill','fileName','fileSize','btnClearFile','pickRow','btnPickFile','btnToggleText',
      'fileInput','textBox','textInput','modeSeg','modeHint','rotToggle',
      'fpsRange','fpsVal','compRange','compVal','stBytesPerFrame','stRate','stFrames',
      'btnBroadcast','btnPause','btnStop','bcastHud','btnPauseFs','btnExitFs',
      'recvVideo','xhTL','xhBR','recvOff','recvDone','recvDoneName','recvDoneSize',
      'recvDoneFrames','recvDoneMode','btnSaveRecv','btnRecvAgain','recvLive','recvBar',
      'recvPct','recvModeLabel','rcDispatched','rcHits','rcFail','recvMatrix','recvModeSeg',
      'captureSel','btnScan','btnTorch','btnRecvReset','btnScanStop',
      'importPill','importName','importMeta','btnPickVideo','importInput','importDone',
      'importDoneName','importDoneSize','importDoneFrames','importDoneMode','btnSaveImport',
      'importLive','importBar','importPct','importTime','importFrames','importHits',
      'importMode','impModeSeg','impSpeed','impCapture','btnDecodeImport','btnImportStop',
      'panel-send','panel-receive','panel-import'];
    for (const id of ids) if (!document.getElementById(id)) problems.push('missing element #' + id);

    // ---- 2. modules loaded ----
    for (const k of ['AirCimbar','AirCimbarSender','AirCimbarReceiver','AirCimbarImport'])
      if (!window[k]) problems.push('missing module window.' + k);
    if (window.AirCimbar) {
      for (const m of [4, 8, 66, 67, 68])
        if (!window.AirCimbar.MODES[m]) problems.push('mode table missing ' + m);
    }

    // ---- 3. tab switching ----
    for (const t of ['receive','import','send']) {
      document.querySelector('.tabs button[data-tab="' + t + '"]').click();
      await sleep(60);
      const p = document.getElementById('panel-' + t);
      if (!p.classList.contains('active')) problems.push('tab ' + t + ' did not activate');
      const others = ['send','receive','import'].filter(x => x !== t);
      for (const o of others)
        if (document.getElementById('panel-' + o).classList.contains('active'))
          problems.push('tab ' + t + ' left ' + o + ' active');
    }

    // ---- 3b. send panel ordering: broadcast buttons sit under the file picker ----
    {
      const panel = document.getElementById('panel-send');
      const order = (id) => {
        const el = document.getElementById(id);
        return Array.prototype.indexOf.call(panel.querySelectorAll('*'), el);
      };
      const picker = order('btnPickFile');
      const bcast = order('btnBroadcast');
      const modeSeg = order('modeSeg');
      const fps = order('fpsRange');
      if (!(picker < bcast && bcast < modeSeg && bcast < fps)) {
        problems.push('开始广播按钮的位置不对：期望在文件选择之后、模式/参数之前 (picker=' +
          picker + ' bcast=' + bcast + ' mode=' + modeSeg + ' fps=' + fps + ')');
      }
    }

    // ---- 3c. default frame rate ----
    if (document.getElementById('fpsRange').value !== '24') {
      problems.push('帧率默认值应为 24，实际 ' + document.getElementById('fpsRange').value);
    }
    if (document.getElementById('fpsVal').textContent !== '24 fps') {
      problems.push('帧率标签应为 24 fps，实际 ' + document.getElementById('fpsVal').textContent);
    }

    // ---- 3d. the file pill must not touch whatever follows it ----
    // (measured here because the send panel is the active one; measuring while
    //  another tab is showing yields two zero-height rects and a fake 0px gap)
    {
      const pill = document.getElementById('filePill');
      const pick = document.getElementById('pickRow');
      if (pick.getBoundingClientRect().height === 0) {
        problems.push('间距检查时发送面板不可见，测量无效');
      } else {
        const wasHidden = pill.classList.contains('hidden');
        pill.classList.remove('hidden');
        const gap = pick.getBoundingClientRect().top - pill.getBoundingClientRect().bottom;
        if (gap < 8) problems.push('文件信息框与下方按钮间距过小 (' + gap.toFixed(1) + 'px)');
        if (wasHidden) pill.classList.add('hidden');
      }
    }

    // ---- 4. send panel controls ----
    document.querySelector('#modeSeg button[data-mode="67"]').click();
    await sleep(50);
    if (document.querySelector('#modeSeg button[data-mode="67"]').getAttribute('aria-pressed') !== 'true')
      problems.push('mode Bm not selected');
    if (!/长条/.test(document.getElementById('modeHint').textContent))
      problems.push('mode hint not updated for Bm');
    const bpf = document.getElementById('stBytesPerFrame').textContent;
    const wantBpf = window.AirCimbar.fmtBytes(window.AirCimbar.MODES[67].bytesPerFrame);
    if (bpf !== wantBpf) problems.push('bytes-per-frame not updated for Bm (got ' + bpf + ', want ' + wantBpf + ')');

    document.getElementById('rotToggle').click();
    await sleep(30);
    if (document.getElementById('rotToggle').textContent.trim() !== '开')
      problems.push('rotate toggle did not latch on');

    document.querySelector('#modeSeg button[data-mode="68"]').click();
    await sleep(30);
    if (document.getElementById('rotToggle').textContent.trim() !== '关')
      problems.push('rotate should reset when leaving Bm');

    const fpsEl = document.getElementById('fpsRange');
    fpsEl.value = '20'; fpsEl.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
    if (document.getElementById('fpsVal').textContent !== '20 fps') problems.push('fps label not updated');
    const rate = document.getElementById('stRate').textContent;
    const wantRate = window.AirCimbar.fmtBytes(window.AirCimbar.MODES[68].bytesPerFrame * 20) + '/s';
    if (rate !== wantRate) problems.push('rate calc wrong at 20fps (got ' + rate + ', want ' + wantRate + ')');

    const cmp = document.getElementById('compRange');
    // a real drag fires input continuously then change on release
    cmp.value = '9'; cmp.dispatchEvent(new Event('input', { bubbles: true }));
    cmp.dispatchEvent(new Event('change', { bubbles: true }));
    if (document.getElementById('compVal').textContent !== '9') problems.push('compression label not updated');

    document.getElementById('btnToggleText').click();
    await sleep(50);
    if (document.getElementById('textBox').classList.contains('hidden')) problems.push('text box did not open');
    document.getElementById('btnToggleText').click();
    await sleep(50);

    // ---- 5. receiver mode + capture controls ----
    document.querySelector('.tabs button[data-tab="receive"]').click();
    await sleep(60);
    document.querySelector('#recvModeSeg button[data-mode="66"]').click();
    await sleep(50);
    if (!/固定 Bu/.test(document.getElementById('recvModeLabel').textContent))
      problems.push('receiver mode label wrong (got ' + document.getElementById('recvModeLabel').textContent + ')');
    const cap = document.getElementById('captureSel');
    cap.value = '960'; cap.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.AirCimbarReceiver.state.captureMax !== 960) problems.push('captureMax not applied');
    document.querySelector('#recvModeSeg button[data-mode="0"]').click();
    await sleep(30);

    document.getElementById('btnRecvReset').click();
    await sleep(30);
    if (document.getElementById('recvPct').textContent !== '0%') problems.push('reset did not clear progress');

    // ---- 6. import panel controls ----
    document.querySelector('.tabs button[data-tab="import"]').click();
    await sleep(60);
    document.querySelector('#impModeSeg button[data-mode="68"]').click();
    await sleep(40);
    if (document.getElementById('importMode').textContent.trim() !== 'B')
      problems.push('import mode label wrong (got ' + document.getElementById('importMode').textContent + ')');
    if (!document.getElementById('btnDecodeImport').disabled)
      problems.push('decode button should be disabled with no file chosen');
    const sp = document.getElementById('impSpeed'); sp.value = '2';
    const ic = document.getElementById('impCapture'); ic.value = '1920';

    // ---- 7. the toast must be fully off-screen while hidden ----
    // Regression: the hidden state used to slide by 140% of the element's own
    // height, so an *empty* toast barely moved and left a sliver of the black
    // pill parked above the bottom edge.
    {
      const toast = document.getElementById('toast');
      const checkHidden = (label) => {
        const r = toast.getBoundingClientRect();
        const vh = window.innerHeight;
        const exposed = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        if (r.width > 0 && exposed > 0.5) {
          problems.push('toast 隐藏时仍露出 ' + exposed.toFixed(1) + 'px（' + label + '）');
        }
      };
      const wasShown = toast.classList.contains('show');
      toast.classList.remove('show');
      toast.textContent = '';
      checkHidden('空内容');
      toast.textContent = '这是一条测试提示';
      checkHidden('有内容');
      if (wasShown) toast.classList.add('show');
      toast.textContent = '';
    }

    // ---- 8. no horizontal overflow (mobile layout sanity) ----
    if (document.documentElement.scrollWidth > window.innerWidth + 1)
      problems.push('horizontal overflow: scrollWidth=' + document.documentElement.scrollWidth + ' innerWidth=' + window.innerWidth);

    // ---- 9. text mode prepares automatically, no separate broadcast button ----
    // This one has to load the wasm engine, so it is the last thing the script does.
    document.querySelector('.tabs button[data-tab="send"]').click();
    await sleep(80);
    document.getElementById('btnToggleText').click();
    await sleep(80);
    if (document.getElementById('textBox').classList.contains('hidden')) {
      problems.push('发送文字没有打开文本框');
    } else {
      const ta = document.getElementById('textInput');
      ta.value = 'aircimbar 文本自动准备测试';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('blur', { bubbles: true }));

      let prepared = false;
      for (let i = 0; i < 90; i++) {
        await sleep(300);
        if (!document.getElementById('btnBroadcast').disabled) { prepared = true; break; }
      }
      if (!prepared) problems.push('输入文字后「开始广播」没有变为可用（自动准备失败）');
      if (document.getElementById('filePill').classList.contains('hidden')) {
        problems.push('输入文字后没有显示文件信息框');
      } else if (!/^text-.*\.txt$/.test(document.getElementById('fileName').textContent)) {
        problems.push('文字载荷的文件名不对: ' + document.getElementById('fileName').textContent);
      }
    }

    return problems;
  })()`;

  let r = null;
  for (let attempt = 1; attempt <= 3 && !r; attempt++) {
    try { r = await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }); }
    catch (e) { await sleep(2000); }
  }
  report = r && r.result && r.result.value;
  if (!report && r && r.exceptionDetails) problems.push('evaluate threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));

  // console errors / uncaught exceptions raised while driving the UI
  await sleep(600);
  for (const ev of cdp.events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      problems.push('uncaught exception: ' + (d.exception && d.exception.description || d.text));
    }
    if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      const t = ev.params.entry.text || '';
      if (!/favicon|net::ERR_FILE_NOT_FOUND/i.test(t)) problems.push('console error: ' + t);
    }
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      problems.push('console.error: ' + ev.params.args.map(a => a.value || a.description || '').join(' '));
    }
  }
  cdp.close();
} catch (e) {
  problems.push('driver failure: ' + e.message);
}

clearTimeout(watchdog);
chrome.kill('SIGKILL');
server.close();

if (Array.isArray(report)) problems.push(...report);
else if (report && report.length) problems.push(...report);

if (problems.length) {
  console.error('\n❌ UI smoke test found ' + problems.length + ' problem(s):');
  for (const p of new Set(problems)) console.error('   • ' + p);
  console.error('');
  process.exit(1);
}
console.log('✅ UI smoke test passed — all elements present, all tabs and controls wired, no console errors');
process.exit(0);
