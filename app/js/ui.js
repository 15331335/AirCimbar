/* ==========================================================================
   AirCimbar — UI glue
   ========================================================================== */
(function () {
  'use strict';

  var A = window.AirCimbar;
  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------- chrome */
  function setStatus(text, live) {
    $('statusText').textContent = text;
    $('statusDot').classList.toggle('live', !!live);
  }

  var scrolled = false;
  window.addEventListener('scroll', function () {
    var s = window.scrollY > 6;
    if (s !== scrolled) { scrolled = s; $('topbar').classList.toggle('scrolled', s); }
  }, { passive: true });

  /* tabs */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs button'));
  var currentTab = 'send';
  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.tab;
      if (t === currentTab) return;
      tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      ['send', 'receive', 'import'].forEach(function (n) {
        $('panel-' + n).classList.toggle('active', n === t);
      });
      currentTab = t;
      window.scrollTo({ top: 0 });
      leaveTab(t);
    });
  });

  function leaveTab(entering) {
    /* never keep the camera running on another tab */
    if (entering !== 'receive' && window.AirCimbarReceiver.state.running) {
      window.AirCimbarReceiver.stop();
      recvUI.stopped();
    }
    if (entering !== 'import' && window.AirCimbarImport.state.running) {
      window.AirCimbarImport.stop();
      impUI.stopped();
    }
  }

  /* deep link: index.html?tab=receive opens straight into a tab, so the app can
     be added to the home screen on whichever side you use it for */
  (function applyDeepLink() {
    var want = new URLSearchParams(location.search).get('tab');
    if (!want) return;
    var btn = tabs.filter(function (b) { return b.dataset.tab === want; })[0];
    if (btn && want !== currentTab) setTimeout(function () { btn.click(); }, 0);
  })();

  /* --------------------------------------------------------------- save */
  /* When the app runs inside the iOS shell a native bridge is present.
     WKWebView cannot download blob: URLs, and the system share sheet is a
     better save destination than a download anyway, so prefer the bridge. */
  function nativeBridge() {
    return (window.webkit && window.webkit.messageHandlers &&
      window.webkit.messageHandlers.aircimbar) || null;
  }

  function postNative(payload) {
    var bridge = nativeBridge();
    if (!bridge) return false;
    try { bridge.postMessage(payload); return true; } catch (e) { return false; }
  }

  /* Chunked base64: a 33 MB file becomes ~44 MB of text, so it has to be
     streamed rather than sent as one message. */
  function saveViaBridge(blob, name) {
    if (!postNative({ type: 'fileBegin', name: name, size: blob.size, mime: blob.type || 'application/octet-stream' })) {
      return false;
    }
    var CHUNK = 512 * 1024;
    var offset = 0;

    function next() {
      if (offset >= blob.size) { postNative({ type: 'fileEnd' }); return; }
      var slice = blob.slice(offset, offset + CHUNK);
      offset += CHUNK;
      var reader = new FileReader();
      reader.onload = function () {
        var bytes = new Uint8Array(reader.result);
        var binary = '';
        for (var i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        postNative({ type: 'fileChunk', data: btoa(binary) });
        next();
      };
      reader.onerror = function () { A.toast('写入失败'); };
      reader.readAsArrayBuffer(slice);
    }
    next();
    return true;
  }

  function saveBlob(blob, name) {
    name = name || 'aircimbar.bin';

    if (nativeBridge()) {
      A.toast('正在准备保存…');
      if (saveViaBridge(blob, name)) return;
    }

    var file = new File([blob], name, { type: blob.type || 'application/octet-stream' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).then(function () {
        A.toast('已交给系统保存');
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return;
        anchorDownload(blob, name);
      });
      return;
    }
    anchorDownload(blob, name);
  }

  function anchorDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
    A.toast('已开始下载 ' + name);
  }

  function modeLabel(id) {
    if (!id) return '自动';
    return (A.MODES[id] && A.MODES[id].key) || String(id);
  }

  function bindSeg(container, onPick) {
    var btns = Array.prototype.slice.call(container.querySelectorAll('button'));
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        onPick(parseInt(b.dataset.mode, 10));
      });
    });
  }

  /* ================================================================ SEND */
  var sender = window.AirCimbarSender;
  var sendUI = {
    mode: 66,        // Bu — matches the default in send.js, see the note there
    paused: false,
  };

  sender.init($('qrCanvas'));

  sender.on('status', function (s) { setStatus(s, false); });
  sender.on('error', function (e) { A.toast(String(e.message || e), 4200); setStatus('出错', false); });

  sender.on('reconfiguring', function (busy) {
    if (busy && sender.state.running) setStatus('正在应用设置…', false);
    else if (!busy && sender.state.running) setStatus('广播中 · 屏幕别熄灭', true);
  });

  sender.on('prepared', function (info) {
    $('filePill').classList.remove('hidden');
    $('fileName').textContent = info.name;
    $('fileSize').textContent = A.fmtBytes(info.size);
    $('btnBroadcast').disabled = false;
    setStatus('已就绪，可以广播', false);
  });

  sender.on('tick', function (s) {
    $('stFrames').textContent = s.frames;
    if (s.loops) $('stFrames').textContent = s.frames + ' ↻' + s.loops;
  });

  sender.on('loop', function () { A.toast('一轮播完，从头继续循环'); });
  sender.on('started', function () {
    sendUI.paused = false;
    $('btnBroadcast').disabled = true;
    $('btnBroadcast').textContent = '正在广播…';
    $('btnPause').disabled = false;
    $('btnPause').textContent = '暂停';
    $('btnStop').disabled = false;
    $('stagePlaceholder').classList.add('hidden');
    setStatus('广播中 · 屏幕别熄灭', true);
    /* native shell holds the screen awake; the web layer alone cannot */
    postNative({ type: 'keepAwake', on: true });
  });
  sender.on('paused', function (p) {
    sendUI.paused = p;
    $('btnPause').textContent = p ? '继续' : '暂停';
    $('btnPauseFs').textContent = p ? '继续' : '暂停';
    setStatus(p ? '已暂停' : '广播中 · 屏幕别熄灭', !p);
  });
  sender.on('stopped', function () {
    $('btnBroadcast').disabled = !sender.state.prepared;
    $('btnBroadcast').textContent = '开始广播';
    $('btnPause').disabled = true;
    $('btnStop').disabled = true;
    setStatus('已停止', false);
    postNative({ type: 'keepAwake', on: false });
  });
  sender.on('cleared', function () {
    $('filePill').classList.add('hidden');
    $('btnBroadcast').disabled = true;
  });

  function refreshRate() {
    var m = A.MODES[sendUI.mode];
    var fps = parseInt($('fpsRange').value, 10);
    $('stBytesPerFrame').textContent = A.fmtBytes(m.bytesPerFrame);
    $('stRate').textContent = A.fmtRate(m.bytesPerFrame * fps);
  }

  bindSeg($('modeSeg'), function (m) {
    sendUI.mode = m;
    /* Bm is the only landscape-ish mode; the rotate toggle is most useful there */
    $('rotToggle').disabled = false;
    if (m !== 67) setRotate(false);
    $('modeHint').textContent = A.MODES[m].note;
    sender.setMode(m);
    refreshRate();
  });

  $('fpsRange').addEventListener('input', function () {
    $('fpsVal').textContent = this.value + ' fps';
    sender.setFps(parseInt(this.value, 10));
    refreshRate();
  });

  function syncCompLabel() { $('compVal').textContent = $('compRange').value; }
  $('compRange').addEventListener('input', syncCompLabel);
  $('compRange').addEventListener('change', function () {
    syncCompLabel();
    sender.setCompression(parseInt(this.value, 10));
  });

  var rotated = false;
  function setRotate(on_) {
    rotated = on_;
    $('rotToggle').textContent = on_ ? '开' : '关';
    $('rotToggle').setAttribute('aria-pressed', String(on_));
    sender.setRotate(on_);
  }
  $('rotToggle').addEventListener('click', function () { setRotate(!rotated); });

  $('btnPickFile').addEventListener('click', function () { $('fileInput').click(); });

  $('fileInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (f.size > sender.MAX_PAYLOAD) {
      A.toast('文件过大：' + A.fmtBytes(f.size) + '，上限约 33 MB', 5000);
      this.value = '';
      return;
    }
    $('textBox').classList.add('hidden');
    setStatus('正在压缩并准备…', false);
    sender.prepare(f, f.name).catch(function (e) { A.toast(String(e.message || e), 5000); setStatus('准备失败', false); });
  });

  $('btnClearFile').addEventListener('click', function () {
    sender.clear();
    $('fileInput').value = '';
    $('textInput').value = '';
    lastPreparedText = null;
    $('stagePlaceholder').classList.remove('hidden');
    setStatus('就绪', false);
  });

  $('btnToggleText').addEventListener('click', function () {
    var box = $('textBox');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) $('textInput').focus();
  });

  /* Text is prepared automatically, the same way picking a file does, so there
     is exactly one way to start sending. The old separate "广播这段文字"
     button both duplicated 开始广播 and was mislabelled — it only prepared. */
  var textTimer = null;
  var lastPreparedText = null;

  function prepareText() {
    var text = $('textInput').value;
    if (text === lastPreparedText) return;

    if (!text) {
      lastPreparedText = null;
      if (sender.state.fileName.indexOf('text-') === 0) {
        sender.clear();
        $('stagePlaceholder').classList.remove('hidden');
        setStatus('就绪', false);
      }
      return;
    }

    var blob = new Blob([new TextEncoder().encode(text)], { type: 'text/plain;charset=utf-8' });
    var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    setStatus('正在准备文字…', false);
    sender.prepare(blob, 'text-' + stamp + '.txt')
      .then(function () { lastPreparedText = text; })
      .catch(function (e) { A.toast(String(e.message || e), 5000); setStatus('准备失败', false); });
  }

  $('textInput').addEventListener('input', function () {
    clearTimeout(textTimer);
    textTimer = setTimeout(prepareText, 500);   // wait for a pause in typing
  });
  $('textInput').addEventListener('blur', function () {
    clearTimeout(textTimer);
    prepareText();
  });

  $('btnBroadcast').addEventListener('click', function () {
    setStatus('正在加载编码引擎…', false);
    sender.ensureWasm()
      .then(function () { return sender.setMode(sendUI.mode); })
      .then(function () { return sender.start(); })
      .catch(function (e) { A.toast(String(e.message || e), 5000); setStatus('启动失败', false); });
  });

  $('btnPause').addEventListener('click', function () { sender.pause(); });
  $('btnPauseFs').addEventListener('click', function () { sender.pause(); });
  $('btnStop').addEventListener('click', function () { sender.stop(); });

  /* broadcasting display mode: hide all chrome, fill the screen with the code */
  function enterFs() {
    document.body.classList.add('broadcasting');
    $('bcastHud').classList.remove('hidden');
    var el = $('stage');
    if (el.requestFullscreen) el.requestFullscreen().catch(function () { });
    setStatus('广播中 · 屏幕别熄灭', true);
  }
  function exitFs() {
    document.body.classList.remove('broadcasting');
    $('bcastHud').classList.add('hidden');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { });
  }
  $('btnExitFs').addEventListener('click', exitFs);
  $('stage').addEventListener('dblclick', function () {
    if (!document.body.classList.contains('broadcasting')) enterFs();
  });

  refreshRate();

  /* ============================================================= RECEIVE */
  var receiver = window.AirCimbarReceiver;
  receiver.init($('recvVideo'), document.createElement('canvas'));

  var matrix = [];
  function pushMatrix(kind) {
    matrix.push(kind);
    if (matrix.length > 60) matrix.shift();
    var html = '';
    for (var i = 0; i < matrix.length; i++) {
      html += '<i class="' + (matrix[i] === 'hit' ? 'hit' : matrix[i] === 'fail' ? 'part' : 'miss') + '"></i>';
    }
    $('recvMatrix').innerHTML = html;
  }

  var recvUI = {
    mode: 0,
    done: null,

    stopped: function () {
      $('btnScan').textContent = '开始扫描';
      $('btnScan').disabled = false;
      $('btnScanStop').disabled = true;
      $('recvOff').classList.remove('hidden');
      $('xhTL').className = 'xh tl';
      $('xhBR').className = 'xh br';
      setStatus('已停止', false);
    },
  };

  receiver.on('status', function (s) { setStatus(s, false); });
  receiver.on('error', function (e) { A.toast(String(e.message || e), 4600); });
  receiver.on('camera', function (c) {
    if (c.on) $('recvOff').classList.add('hidden');
  });
  receiver.on('started', function () {
    $('btnScan').textContent = '扫描中…';
    $('btnScan').disabled = true;
    $('btnScanStop').disabled = false;
    setStatus('正在扫描…', true);
  });
  receiver.on('stopped', function () { recvUI.stopped(); });

  receiver.on('frame', function (s) {
    $('rcDispatched').textContent = s.dispatched;
    $('rcHits').textContent = s.ok;
    $('rcFail').textContent = s.fail;

    var r = receiver.state.recent;
    if (r === 'hit') { $('xhTL').className = 'xh tl lock'; $('xhBR').className = 'xh br lock'; }
    else if (r === 'fail') { $('xhTL').className = 'xh tl scan'; $('xhBR').className = 'xh br scan'; }
    else { $('xhTL').className = 'xh tl'; $('xhBR').className = 'xh br'; }
    pushMatrix(r);
    receiver.state.recent = null;
  });

  receiver.on('locked', function (m) {
    $('recvModeLabel').textContent = '已锁定 ' + modeLabel(m);
    A.toast('识别到 ' + modeLabel(m) + ' 模式');
  });

  receiver.on('progress', function (p) {
    $('recvBar').style.width = (p * 100).toFixed(1) + '%';
    $('recvPct').textContent = (p * 100).toFixed(1) + '%';
  });

  receiver.on('complete', function (info) {
    recvUI.done = info;
    $('recvDoneName').textContent = info.name;
    $('recvDoneSize').textContent = A.fmtBytes(info.size);
    $('recvDoneFrames').textContent = receiver.state.scanOk;
    $('recvDoneMode').textContent = modeLabel(receiver.state.lockedMode);
    $('recvDone').style.display = '';
    $('recvBar').classList.add('ok');
    setStatus('接收完成', false);
    A.toast('文件接收完成，记得保存！', 4000);
    receiver.stop();
  });

  bindSeg($('recvModeSeg'), function (m) {
    recvUI.mode = m;
    receiver.setMode(m);
    $('recvModeLabel').textContent = m ? '固定 ' + modeLabel(m) : '自动识别';
    matrix = [];
    $('recvMatrix').innerHTML = '';
  });

  $('captureSel').addEventListener('change', function () {
    receiver.setCaptureMax(parseInt(this.value, 10));
  });

  $('btnScan').addEventListener('click', function () {
    $('recvDone').style.display = 'none';
    $('recvBar').classList.remove('ok');
    $('recvBar').style.width = '0%';
    $('recvPct').textContent = '0%';
    matrix = [];
    receiver.start().then(function () {
      $('btnTorch').style.display = receiver.torchSupported() ? '' : 'none';
    }).catch(function (e) {
      A.toast(String(e.message || e), 5000);
      setStatus('无法启动摄像头', false);
      recvUI.stopped();
    });
  });

  $('btnScanStop').addEventListener('click', function () { receiver.stop(); });
  $('btnRecvReset').addEventListener('click', function () {
    receiver.reset();
    matrix = [];
    $('recvMatrix').innerHTML = '';
    $('recvDone').style.display = 'none';
    $('recvBar').classList.remove('ok');
    $('recvBar').style.width = '0%';
    $('recvPct').textContent = '0%';
    $('rcHits').textContent = '0';
    $('rcDispatched').textContent = '0';
    $('rcFail').textContent = '0';
    A.toast('进度已重置');
  });
  $('btnSaveRecv').addEventListener('click', function () {
    if (recvUI.done) saveBlob(recvUI.done.blob, recvUI.done.name);
  });
  $('btnRecvAgain').addEventListener('click', function () {
    $('recvDone').style.display = 'none';
    $('btnRecvReset').click();
    $('btnScan').click();
  });

  var torchOn = false;
  $('btnTorch').addEventListener('click', function () {
    torchOn = !torchOn;
    receiver.torch(torchOn).then(function (ok) {
      if (!ok) { torchOn = false; A.toast('此设备不支持补光灯控制'); }
      $('btnTorch').textContent = torchOn ? '关补光' : '补光灯';
    });
  });

  /* ============================================================== IMPORT */
  var importer = window.AirCimbarImport;
  importer.init({
    video: document.createElement('video'),
    canvas: document.createElement('canvas'),
  });

  var impUI = {
    mode: 0,
    file: null,
    done: null,
    stopped: function () {
      $('btnDecodeImport').disabled = !impUI.file;
      $('btnDecodeImport').textContent = '开始解码';
      $('btnImportStop').disabled = true;
      setStatus('已停止', false);
    },
  };

  importer.on('status', function (s) { setStatus(s, false); });
  importer.on('error', function (e) { A.toast(String(e.message || e), 4600); });

  importer.on('loaded', function (m) {
    $('importMeta').textContent = m.kind === 'image'
      ? m.w + '×' + m.h + ' 图片'
      : m.w + '×' + m.h + ' · ' + (m.duration ? m.duration.toFixed(1) + 's' : '视频');
  });

  importer.on('frame', function (s) {
    $('importFrames').textContent = s.frames;
    $('importHits').textContent = s.ok;
    $('importTime').textContent = s.duration
      ? s.t.toFixed(1) + ' / ' + s.duration.toFixed(1) + 's'
      : '—';
  });

  importer.on('locked', function (m) {
    $('importMode').textContent = modeLabel(m);
    A.toast('识别到 ' + modeLabel(m) + ' 模式');
  });

  importer.on('progress', function (p) {
    $('importBar').style.width = (p * 100).toFixed(1) + '%';
    $('importPct').textContent = (p * 100).toFixed(1) + '%';
  });

  importer.on('incomplete', function (s) {
    A.toast('文件未完成：共处理 ' + s.frames + ' 帧、成功解码 ' + s.ok + ' 帧。可换更高的解码分辨率或更慢的播放速度重试。', 6000);
  });

  importer.on('complete', function (info) {
    impUI.done = info;
    $('importDoneName').textContent = info.name;
    $('importDoneSize').textContent = A.fmtBytes(info.size);
    $('importDoneFrames').textContent = importer.state.scanOk;
    $('importDoneMode').textContent = modeLabel(importer.state.lockedMode);
    $('importDone').style.display = '';
    $('importBar').classList.add('ok');
    setStatus('解码完成', false);
    A.toast('视频解码完成！', 4000);
  });

  importer.on('stopped', function () { impUI.stopped(); });

  bindSeg($('impModeSeg'), function (m) {
    impUI.mode = m;
    $('importMode').textContent = m ? modeLabel(m) : '—';
  });

  $('btnPickVideo').addEventListener('click', function () { $('importInput').click(); });

  $('importInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    impUI.file = f;
    $('importPill').classList.remove('hidden');
    $('importName').textContent = f.name;
    $('importMeta').textContent = A.fmtBytes(f.size);
    $('btnDecodeImport').disabled = false;
    $('importDone').style.display = 'none';
    $('importBar').classList.remove('ok');
    $('importBar').style.width = '0%';
    $('importPct').textContent = '0%';
  });

  $('btnDecodeImport').addEventListener('click', function () {
    if (!impUI.file) return;
    $('importDone').style.display = 'none';
    $('btnDecodeImport').disabled = true;
    $('btnDecodeImport').textContent = '解码中…';
    $('btnImportStop').disabled = false;
    importer.release();
    importer.decodeFile(impUI.file, {
      mode: impUI.mode,
      speed: parseFloat($('impSpeed').value),
      captureMax: parseInt($('impCapture').value, 10),
    }).then(function () {
      impUI.stopped();
    }).catch(function (e) {
      A.toast(String(e.message || e), 5000);
      impUI.stopped();
    });
  });

  $('btnImportStop').addEventListener('click', function () { importer.stop(); });
  $('btnSaveImport').addEventListener('click', function () {
    if (impUI.done) saveBlob(impUI.done.blob, impUI.done.name);
  });

  /* ================================================================= PWA */
  /* Service workers need a secure context. Testing isSecureContext rather than
     the scheme also covers http://127.0.0.1 and http://localhost, which
     browsers treat as trustworthy — and which is how the test suite serves the
     app. Plain http on a LAN address is still correctly skipped. */
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    });
  }

  /* backgrounding while broadcasting must not leave the screen pinned on */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') postNative({ type: 'keepAwake', on: false });
    else if (sender.state.running && !sender.state.paused) postNative({ type: 'keepAwake', on: true });
  });

  postNative({ type: 'ready' });
  setStatus('就绪', false);
})();
