/* ==========================================================================
   AirCimbar — import decoder
   AirScan-QR's "screen scan" idea, adapted: decode an already-recorded
   video (a screen recording of a sender) or a still image, instead of a
   live camera feed. Same wasm worker pipeline as the receiver.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.AirCimbar;

  var I = {
    video: null,
    canvas: null,
    ctx: null,

    workers: [],
    sink: null,
    inFlight: 0,
    nextWorker: 0,

    running: false,
    modeId: 0,
    lockedMode: 0,
    captureMax: 1280,
    speed: 1,

    frames: 0,
    scanOk: 0,
    scanFail: 0,
    progress: 0,
    done: false,

    fileChunks: [],
    fileName: '',
    fileSize: 0,
    objectURL: null,

    listeners: {},
  };

  function emit(n, a) { var l = I.listeners[n]; if (l) for (var i = 0; i < l.length; i++) l[i](a); }
  function on(n, cb) { (I.listeners[n] = I.listeners[n] || []).push(cb); }

  function init(opts) {
    I.video = opts.video;
    I.canvas = opts.canvas;
    I.ctx = I.canvas.getContext('2d', { willReadFrequently: true });
  }

  /* ------------------------------------------------------------- workers */
  function spawn() {
    if (I.workers.length) return Promise.resolve();
    var url = new URL('js/cimbar-worker.js', document.baseURI).href;
    var n = 2;
    var ready = [];

    for (var i = 0; i < n; i++) {
      var w = new Worker(url);
      w.onmessage = function (ev) { onScan(ev.data); };
      ready.push(handshake(w, 'scan'));
      I.workers.push(w);
    }
    I.sink = new Worker(url);
    I.sink.onmessage = function (ev) { onSink(ev.data); };
    ready.push(handshake(I.sink, 'sink'));

    return Promise.all(ready);
  }

  function handshake(w, role) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('worker 初始化超时')); }, 45000);
      function h(ev) {
        if (ev.data && ev.data.type === 'ready') { w.removeEventListener('message', h); clearTimeout(t); resolve(); }
        else if (ev.data && ev.data.type === 'error') { clearTimeout(t); reject(new Error(ev.data.message)); }
      }
      w.addEventListener('message', h);
      w.postMessage({ type: 'init', role: role, mode: role === 'sink' ? (I.modeId || 68) : I.modeId });
    });
  }

  function teardown() {
    I.workers.forEach(function (w) { w.terminate(); });
    I.workers = [];
    if (I.sink) { I.sink.terminate(); I.sink = null; }
    I.inFlight = 0;
  }

  /* -------------------------------------------------------------- frames */
  function grab(source, w, h) {
    var long = Math.max(w, h);
    var scale = long > I.captureMax ? I.captureMax / long : 1;
    var tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    if (I.canvas.width !== tw || I.canvas.height !== th) { I.canvas.width = tw; I.canvas.height = th; }
    I.ctx.drawImage(source, 0, 0, tw, th);
    var img = I.ctx.getImageData(0, 0, tw, th);
    return { pixels: new Uint8Array(img.data.buffer), w: tw, h: th };
  }

  function dispatch(pixels, w, h) {
    var mode = I.lockedMode || I.modeId;
    if (!mode) mode = A.AUTO_ORDER[I.frames % A.AUTO_ORDER.length];
    var w0 = I.workers[I.nextWorker];
    I.nextWorker = (I.nextWorker + 1) % I.workers.length;
    I.inFlight++;
    I.frames++;
    w0.postMessage({ type: 'frame', pixels: pixels.buffer, w: w, h: h, format: 4, mode: mode },
      [pixels.buffer]);
  }

  function onScan(d) {
    if (!d) return;
    I.inFlight = Math.max(0, I.inFlight - 1);
    if (d.type === 'error') { emit('error', new Error(d.message)); return; }
    if (d.type === 'nodata' || d.type === 'fail') { I.scanFail++; return; }
    if (d.type !== 'data') return;

    I.scanOk++;
    if (!I.lockedMode && d.mode) {
      I.lockedMode = d.mode;
      emit('locked', d.mode);
      if (I.sink) I.sink.postMessage({ type: 'configure', mode: d.mode });
    }
    if (I.sink && !I.done) I.sink.postMessage({ type: 'data', buff: d.buff }, [d.buff.buffer]);
  }

  function onSink(d) {
    if (!d) return;
    if (d.type === 'error') { emit('error', new Error(d.message)); return; }
    if (d.type === 'progress') {
      if (Array.isArray(d.report) && d.report.length) {
        var p = Math.max.apply(null, d.report.map(Number)) || 0;
        if (p > I.progress) { I.progress = p; emit('progress', p); }
      }
      return;
    }
    if (d.type === 'file-begin') { I.fileName = d.name; I.fileSize = d.size; I.fileChunks = []; return; }
    if (d.type === 'file-chunk') { I.fileChunks.push(d.chunk); return; }
    if (d.type === 'file-end') {
      I.done = true;
      I.progress = 1;
      var blob = new Blob(I.fileChunks, { type: 'application/octet-stream' });
      I.fileChunks = [];
      emit('progress', 1);
      emit('complete', { blob: blob, name: I.fileName, size: blob.size });
    }
  }

  /* ----------------------------------------------------------------- run */
  function reset() {
    I.done = false; I.progress = 0; I.fileChunks = [];
    I.frames = 0; I.scanOk = 0; I.scanFail = 0; I.lockedMode = 0; I.nextWorker = 0;
    if (I.sink) I.sink.postMessage({ type: 'reset', mode: I.modeId || 68 });
    emit('progress', 0);
  }

  function loadFile(file) {
    return new Promise(function (resolve, reject) {
      if (I.objectURL) { URL.revokeObjectURL(I.objectURL); I.objectURL = null; }
      I.objectURL = URL.createObjectURL(file);

      if (file.type.startsWith('image/')) {
        var img = new Image();
        img.onload = function () { resolve({ kind: 'image', source: img, w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = function () { reject(new Error('无法读取图片')); };
        img.src = I.objectURL;
        return;
      }

      var v = document.createElement('video');
      v.playsInline = true;
      v.muted = true;
      v.preload = 'auto';
      /* keep it in the document but out of sight: some browsers stop
         decoding frames from a video that is display:none or detached */
      v.setAttribute('style', 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none');
      document.body.appendChild(v);
      v.onloadedmetadata = function () {
        resolve({ kind: 'video', source: v, w: v.videoWidth, h: v.videoHeight, duration: v.duration });
      };
      v.onerror = function () { reject(new Error('无法读取视频（浏览器可能不支持该编码）')); };
      v.src = I.objectURL;
    });
  }

  function decodeFile(file, opts) {
    opts = opts || {};
    if (opts.mode !== undefined) I.modeId = opts.mode;
    if (opts.captureMax) I.captureMax = opts.captureMax;
    if (opts.speed) I.speed = opts.speed;

    I.running = true;
    reset();
    emit('status', '正在加载解码引擎…');

    return spawn().then(function () {
      if (I.modeId) { I.sink.postMessage({ type: 'configure', mode: I.modeId }); }
      emit('status', '正在读取文件…');
      return loadFile(file);
    }).then(function (media) {
      if (!I.running) return;
      emit('loaded', { kind: media.kind, w: media.w, h: media.h, duration: media.duration || 0 });

      if (media.kind === 'image') {
        emit('status', '解码静态图…');
        var f = grab(media.source, media.w, media.h);
        dispatch(f.pixels, f.w, f.h);
        return waitIdle().then(function () {
          if (!I.done) emit('incomplete', { frames: I.frames, ok: I.scanOk });
          I.running = false;
          emit('stopped', null);
        });
      }

      var v = media.source;
      var started = performance.now();
      emit('status', '正在播放并解码视频…');

      return new Promise(function (resolve) {
        function pump() {
          if (!I.running) { v.pause(); return resolve(); }
          if (v.ended) { v.pause(); return resolve(); }
          if (I.done) { v.pause(); return resolve(); }

          if (I.inFlight < 8) {
            try {
              var f = grab(v, v.videoWidth, v.videoHeight);
              dispatch(f.pixels, f.w, f.h);
            } catch (e) { /* ignore a bad frame */ }
          }
          emit('frame', {
            frames: I.frames, ok: I.scanOk,
            t: v.currentTime, duration: v.duration || 0,
          });
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(pump);
          else setTimeout(pump, 33);
        }

        v.playbackRate = I.speed;
        v.currentTime = 0;
        var p = v.play();
        if (p && p.catch) p.catch(function (e) { emit('error', e); resolve(); });
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(pump);
        else setTimeout(pump, 33);
      });
    }).then(function () {
      return waitIdle();
    }).then(function () {
      if (!I.done && I.running) emit('incomplete', { frames: I.frames, ok: I.scanOk });
      I.running = false;
      emit('stopped', null);
    });
  }

  function waitIdle() {
    return new Promise(function (resolve) {
      (function poll() {
        if (I.inFlight <= 0) return setTimeout(resolve, 120);
        setTimeout(poll, 60);
      })();
    });
  }

  function stop() {
    I.running = false;
    if (I.video) { try { I.video.pause(); } catch (e) { } }
    emit('stopped', null);
  }

  function release() {
    stop();
    teardown();
    if (I.objectURL) { URL.revokeObjectURL(I.objectURL); I.objectURL = null; }
  }

  global.AirCimbarImport = {
    state: I,
    on: on,
    init: init,
    decodeFile: decodeFile,
    stop: stop,
    reset: reset,
    release: release,
  };
})(window);
