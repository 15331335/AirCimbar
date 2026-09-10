/* ==========================================================================
   AirCimbar — receiver
   Camera -> frame capture -> scan workers (wasm) -> fountain sink (wasm)
   -> reassembled file.

   The main thread runs no wasm at all: scanning happens in N workers and
   fountain reassembly in one sink worker. That keeps the UI responsive and
   avoids the encoder and decoder fighting over the module's thread-local
   config when both tabs are live.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.AirCimbar;

  var R = {
    video: null,
    canvas: null,
    ctx: null,

    stream: null,
    track: null,
    running: false,

    workers: [],
    sink: null,
    readyCount: 0,
    totalWorkers: 0,

    modeId: 0,          // 0 = autodetect
    lockedMode: 0,      // set once a decode succeeds
    captureMax: 1280,

    inFlight: 0,
    maxInFlight: 12,
    dispatched: 0,
    scanOk: 0,
    scanFail: 0,
    scanNodata: 0,
    dataFrames: 0,

    progress: 0,
    fileChunks: [],
    fileName: '',
    fileSize: 0,
    done: false,

    lastFrameAt: 0,
    lastSeen: 0,
    watchman: 0,
    pendingRestart: false,

    listeners: {},
  };

  function emit(name, arg) {
    var l = R.listeners[name];
    if (l) for (var i = 0; i < l.length; i++) l[i](arg);
  }
  function on(name, cb) {
    (R.listeners[name] = R.listeners[name] || []).push(cb);
  }

  var workerURL = function () { return new URL('js/cimbar-worker.js', document.baseURI).href; };

  /* --------------------------------------------------------------- setup */
  function init(video, canvas) {
    R.video = video;
    R.canvas = canvas;
    R.ctx = canvas.getContext('2d', { willReadFrequently: true });
    R.maxInFlight = 12;
  }

  function workerCount() {
    var hc = navigator.hardwareConcurrency || 4;
    /* each wasm instance reserves a fixed 128 MB heap — stay modest */
    return Math.min(3, Math.max(1, hc - 3));
  }

  function configureMode(mode) {
    R.modeId = mode;
    R.lockedMode = 0;
    for (var i = 0; i < R.workers.length; i++) {
      R.workers[i].postMessage({ type: 'configure', mode: mode });
    }
    if (R.sink) R.sink.postMessage({ type: 'reset', mode: mode > 0 ? mode : 68 });
  }

  function spawnWorkers() {
    if (R.workers.length) return Promise.resolve();
    var n = workerCount();
    R.totalWorkers = n + 1;
    var ready = [];

    for (var i = 0; i < n; i++) {
      (function () {
        var w = new Worker(workerURL());
        w.onmessage = function (ev) { onScanMessage(w, ev.data); };
        w.onerror = function (e) { emit('error', new Error('扫描 worker 出错: ' + (e.message || e))); };
        ready.push(waitReady(w, 'scan'));
        R.workers.push(w);
      })();
    }

    R.sink = new Worker(workerURL());
    R.sink.onmessage = function (ev) { onSinkMessage(ev.data); };
    R.sink.onerror = function (e) { emit('error', new Error('sink worker 出错: ' + (e.message || e))); };
    ready.push(waitReady(R.sink, 'sink'));

    return Promise.all(ready);
  }

  function waitReady(w, role) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('worker 初始化超时 (' + role + ')')); }, 45000);
      function handler(ev) {
        if (ev.data && ev.data.type === 'ready') {
          w.removeEventListener('message', handler);
          clearTimeout(t);
          emit('status', '解码引擎就绪 (' + (++R.readyCount) + '/' + R.totalWorkers + ')');
          resolve(ev.data);
        } else if (ev.data && ev.data.type === 'error') {
          clearTimeout(t);
          reject(new Error(ev.data.message));
        }
      }
      w.addEventListener('message', handler);
      w.postMessage({ type: 'init', role: role, mode: role === 'sink' ? (R.modeId || 68) : R.modeId });
    });
  }

  /* -------------------------------------------------------------- camera */
  function startCamera() {
    if (R.stream) return Promise.resolve();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('此浏览器不支持摄像头访问'));
    }

    var landscape = window.matchMedia('all and (orientation:landscape)').matches;
    var longEdge = R.captureMax;

    var constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: landscape ? longEdge : Math.round(longEdge * 0.75) },
        height: { ideal: landscape ? Math.round(longEdge * 0.75) : longEdge },
        frameRate: { ideal: 15, max: 30 },
      },
    };

    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      R.stream = stream;
      R.track = stream.getVideoTracks()[0];
      var v = R.video;
      if ('srcObject' in v) v.srcObject = stream;
      else v.src = URL.createObjectURL(stream);
      v.setAttribute('playsinline', '');
      v.muted = true;
      return v.play();
    }).then(function () {
      emit('camera', { on: true });
    });
  }

  function stopCamera() {
    if (R.stream) {
      R.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } });
      R.stream = null;
      R.track = null;
    }
    if (R.video) R.video.srcObject = null;
    emit('camera', { on: false });
  }

  /* --- iOS Safari sometimes freezes the capture; upstream watches for a
         stalled frame counter and re-opens the stream. Same trick here. --- */
  function armWatchman() {
    if (R.watchman) return;
    R.watchman = setInterval(function () {
      if (!R.running) return;
      if (R.dispatched > R.lastSeen) { R.lastSeen = R.dispatched; return; }
      if (R.pendingRestart) return;
      R.pendingRestart = true;
      emit('status', '摄像头似乎卡住了，正在重启…');
      stopCamera();
      startCamera().then(function () {
        R.pendingRestart = false;
        scheduleFrame();
      }).catch(function () { R.pendingRestart = false; });
    }, 1500);
  }
  function disarmWatchman() { clearInterval(R.watchman); R.watchman = 0; }

  /* -------------------------------------------------------- frame capture */
  function captureFrame() {
    var v = R.video;
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;

    var long = Math.max(vw, vh);
    var scale = long > R.captureMax ? R.captureMax / long : 1;
    var tw = Math.round(vw * scale), th = Math.round(vh * scale);

    /* Deliberately always go through a 2D canvas rather than handing the
       browser's native VideoFrame (NV12/I420) straight to the decoder.
       Measured against libcimbar v0.6.8 + wasm: the raw NV12 buffers a
       browser produces fail extraction outright (scan returns -3 on every
       frame), while the RGBA path decodes cleanly. The canvas also gives us
       downscaling and a guaranteed top-down, unpadded row order.
       See test/camera-probe.mjs. */
    if (R.canvas.width !== tw || R.canvas.height !== th) {
      R.canvas.width = tw; R.canvas.height = th;
    }
    R.ctx.drawImage(v, 0, 0, tw, th);
    var img = R.ctx.getImageData(0, 0, tw, th);
    return { pixels: new Uint8Array(img.data.buffer), w: tw, h: th, format: 4 };
  }

  function scheduleFrame() {
    if (!R.running || !R.video) return;
    if (R.video.requestVideoFrameCallback) {
      R.video.requestVideoFrameCallback(function () { onFrame(); });
    } else {
      setTimeout(onFrame, 66);
    }
  }

  function onFrame() {
    if (!R.running) return;
    scheduleFrame();

    if (R.inFlight >= R.maxInFlight) { emit('status', '解码队列已满，丢帧中…'); return; }
    if (R.done) return;

    var fr;
    try { fr = captureFrame(); } catch (e) { emit('error', e); return; }
    if (!fr) return;

    /* autodetect: rotate through the candidate modes until one decodes */
    var mode = R.lockedMode || R.modeId;
    if (!mode) mode = A.AUTO_ORDER[R.dispatched % A.AUTO_ORDER.length];

    var w = R.workers[R.dispatched % R.workers.length];
    R.inFlight++;
    R.dispatched++;
    R.lastFrameAt = performance.now();

    try {
      w.postMessage({ type: 'frame', pixels: fr.pixels.buffer, w: fr.w, h: fr.h, format: fr.format, mode: mode },
        [fr.pixels.buffer]);
    } catch (e) {
      R.inFlight--;
      emit('error', e);
      return;
    }
    emit('frame', { dispatched: R.dispatched, ok: R.scanOk, fail: R.scanFail, nodata: R.scanNodata, mode: mode });
  }

  /* ------------------------------------------------------- worker replies */
  function onScanMessage(w, d) {
    if (!d) return;
    R.inFlight = Math.max(0, R.inFlight - 1);

    if (d.type === 'error') { emit('error', new Error(d.message)); return; }
    if (d.type === 'nodata') { R.scanNodata++; R.recent = 'nodata'; return; }
    if (d.type === 'fail') { R.scanFail++; R.recent = 'fail'; return; }
    if (d.type !== 'data') return;

    R.scanOk++;
    R.dataFrames++;
    R.recent = 'hit';

    /* first successful decode confirms the mode — lock onto it */
    if (!R.lockedMode && d.mode) {
      R.lockedMode = d.mode;
      emit('locked', d.mode);
      if (R.sink) R.sink.postMessage({ type: 'configure', mode: d.mode });
    }

    if (R.sink && !R.done) {
      R.sink.postMessage({ type: 'data', buff: d.buff }, [d.buff.buffer]);
    }
  }

  function onSinkMessage(d) {
    if (!d) return;
    if (d.type === 'error') { emit('error', new Error(d.message)); return; }
    if (d.type === 'progress') { applyReport(d.report); return; }
    if (d.type === 'complete') { emit('complete-start', d.id); return; }
    if (d.type === 'file-begin') {
      R.fileName = d.name || 'aircimbar.bin';
      R.fileSize = d.size || 0;
      R.fileChunks = [];
      return;
    }
    if (d.type === 'file-chunk') { R.fileChunks.push(d.chunk); return; }
    if (d.type === 'file-end') {
      R.done = true;
      R.progress = 1;
      emit('progress', 1);
      var blob = new Blob(R.fileChunks, { type: 'application/octet-stream' });
      R.fileChunks = [];
      emit('complete', { blob: blob, name: R.fileName, size: blob.size });
      return;
    }
  }

  function applyReport(report) {
    if (!Array.isArray(report) || !report.length) return;
    /* the decoder can hold several candidate files at once; show the best */
    var p = Math.max.apply(null, report.map(Number)) || 0;
    if (Math.abs(p - R.progress) > 0.0005) { R.progress = p; emit('progress', p); }
  }

  /* --------------------------------------------------------------- public */
  function start() {
    if (R.running) return Promise.resolve();
    R.running = true;
    R.done = false;
    R.progress = 0;
    R.fileChunks = [];
    R.dispatched = 0; R.scanOk = 0; R.scanFail = 0; R.scanNodata = 0; R.dataFrames = 0;
    R.lockedMode = 0;
    R.lastSeen = 0;

    emit('status', '正在启动摄像头…');
    return startCamera().then(function () {
      emit('status', '正在加载解码引擎…');
      return spawnWorkers();
    }).then(function () {
      if (R.modeId) configureMode(R.modeId);
      armWatchman();
      emit('started', null);
      emit('status', '正在扫描…');
      scheduleFrame();
    }).catch(function (e) {
      R.running = false;
      stopCamera();
      throw e;
    });
  }

  function stop() {
    R.running = false;
    disarmWatchman();
    stopCamera();
    emit('stopped', null);
  }

  function reset() {
    R.done = false;
    R.progress = 0;
    R.fileChunks = [];
    R.scanOk = 0; R.scanFail = 0; R.scanNodata = 0; R.dataFrames = 0; R.dispatched = 0;
    if (R.sink) R.sink.postMessage({ type: 'reset', mode: R.lockedMode || R.modeId || 68 });
    emit('progress', 0);
  }

  function setCaptureMax(px) { R.captureMax = px; }

  function torch(on_) {
    if (!R.track || !R.track.getCapabilities) return Promise.resolve(false);
    var caps = R.track.getCapabilities();
    if (!caps.torch) return Promise.resolve(false);
    return R.track.applyConstraints({ advanced: [{ torch: !!on_ }] }).then(function () { return true; });
  }

  function torchSupported() {
    try {
      return !!(R.track && R.track.getCapabilities && R.track.getCapabilities().torch);
    } catch (e) { return false; }
  }

  global.AirCimbarReceiver = {
    state: R,
    on: on,
    init: init,
    start: start,
    stop: stop,
    reset: reset,
    setMode: configureMode,
    setCaptureMax: setCaptureMax,
    torch: torch,
    torchSupported: torchSupported,
  };
})(window);
