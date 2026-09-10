/* ==========================================================================
   AirCimbar — sender
   Drives the official libcimbar wasm encoder on the main thread and paints
   the animated barcode into a <canvas>.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.AirCimbar;

  /* wirehair fountain codes need the whole payload resident in RAM; upstream
     caps the (compressed) payload at 33.55 MB. */
  var MAX_PAYLOAD = 33 * 1024 * 1024;

  var S = {
    mod: null,
    canvas: null,
    ready: false,
    loading: false,

    /* Bu by default: measured hit rates at a realistic code width of ~430px
       are ~90% for Bu versus ~67% for B (see test/resolution.mjs). B is for
       large displays, Bu is what works phone-to-phone. */
    modeId: 66,
    compression: 16,
    fps: 24,

    blob: null,
    fileName: '',
    fileSize: 0,
    prepared: false,

    running: false,
    paused: false,
    raf: 0,
    lastTs: 0,
    frameCount: 0,
    loops: 0,
    prevCounter: 0,
    startedAt: 0,
    wakeLock: null,

    /* Changing mode or compression calls cimbare_configure(), and upstream
       discards the encoder stream when the payload no longer fills a whole
       chunk under the new settings (cimbare_js.cpp: `_fes = nullptr`). While
       that is true _cimbare_next_frame() returns -1 by design, so the frame
       loop must stand down rather than treat it as a failure. */
    reconfiguring: false,
    frameErrors: 0,

    listeners: {},
  };

  /* ------------------------------------------------------------- events */
  function emit(name, arg) {
    var l = S.listeners[name];
    if (l) for (var i = 0; i < l.length; i++) l[i](arg);
  }
  function on(name, cb) {
    (S.listeners[name] = S.listeners[name] || []).push(cb);
  }
  function off(name, cb) {
    var l = S.listeners[name];
    if (!l) return;
    var i = l.indexOf(cb);
    if (i >= 0) l.splice(i, 1);
  }

  /* ------------------------------------------------------------- loading */
  function ensureWasm() {
    if (S.ready) return Promise.resolve();
    if (S.loading) return S.loading;

    S.loading = new Promise(function (resolve, reject) {
      emit('status', '正在加载编解码引擎…');
      window.Module = A.moduleConfig(S.canvas, function (mod) {
        S.mod = mod;
        try {
          mod._cimbare_init_window(0, 0);
          S.ready = true;
          emit('status', '引擎就绪');
          resolve();
        } catch (e) { reject(e); }
      }, function (line) { emit('log', line); });

      A.loadGlue().catch(reject);

      setTimeout(function () {
        if (!S.ready) reject(new Error('编解码引擎加载超时'));
      }, 30000);
    });
    return S.loading;
  }

  /* ---------------------------------------------------------------- mode */
  function setMode(modeId) {
    S.modeId = modeId;
    if (!S.ready) return;
    var rc = S.mod._cimbare_configure(modeId, S.compression);
    emit('mode', { modeId: modeId, rc: rc, width: S.canvas.width, height: S.canvas.height });
    /* cimbare_configure may resize the GL window, and can drop the prepared
       stream if the payload no longer fills a chunk — re-feed to be safe. */
    if (S.blob) prepare(S.blob, S.fileName).catch(function (e) { emit('error', e); });
  }

  function setCompression(level) {
    S.compression = level;
    if (S.ready) {
      S.mod._cimbare_configure(S.modeId, level);
      if (S.blob) prepare(S.blob, S.fileName).catch(function (e) { emit('error', e); });
    }
  }

  function setFps(fps) { S.fps = fps; }

  function setRotate(on_) {
    if (S.ready) S.mod._cimbare_rotate_window(!!on_);
  }

  /* ------------------------------------------------------------- payload */
  function prepare(blob, fileName) {
    /* Frames must not be requested while the encoder stream is being rebuilt;
       see the comment on S.reconfiguring. */
    S.reconfiguring = true;
    S.frameErrors = 0;
    emit('reconfiguring', true);

    return ensureWasm().then(function () {
      var mod = S.mod;

      if (blob.size > MAX_PAYLOAD) {
        throw new Error('文件过大：' + A.fmtBytes(blob.size) +
          '。wirehair 喷泉码要求整个文件常驻内存，上限约 33 MB。');
      }
      if (blob.size === 0) throw new Error('内容为空');

      S.blob = blob;
      S.fileName = fileName || 'aircimbar.bin';
      S.fileSize = blob.size;

      /* filename -> wasm heap */
      var nameBytes = new TextEncoder().encode(S.fileName);
      var namePtr = mod._malloc(nameBytes.length);
      new Uint8Array(mod.HEAPU8.buffer, namePtr, nameBytes.length).set(nameBytes);
      var initRc = mod._cimbare_init_encode(namePtr, nameBytes.length, -1);
      mod._free(namePtr);
      if (initRc < 0) throw new Error('init_encode 失败 (' + initRc + ')');

      var chunk = mod._cimbare_encode_bufsize();
      var off = 0;

      function step() {
        if (off >= blob.size) {
          /* zero-length call is the flush; returns -1 if the stream already
             completed on the final chunk, which is expected and harmless */
          var rc = mod._cimbare_encode(0, 0);
          if (rc < -1) throw new Error('encode 收尾失败 (' + rc + ')');
          S.prepared = true;
          emit('prepared', { name: S.fileName, size: S.fileSize });
          return Promise.resolve();
        }
        var slice = blob.slice(off, off + chunk);
        return slice.arrayBuffer().then(function (ab) {
          var n = ab.byteLength;
          var p = mod._malloc(n);
          new Uint8Array(mod.HEAPU8.buffer, p, n).set(new Uint8Array(ab));
          var rc = mod._cimbare_encode(p, n);
          mod._free(p);
          off += n;
          if (rc < 0) throw new Error('encode 失败 (' + rc + ')');
          return step();
        });
      }

      return step();
    }).then(function (result) {
      S.reconfiguring = false;
      S.lastTs = 0;          // restart frame pacing cleanly
      S.prevCounter = 0;
      emit('reconfiguring', false);
      return result;
    }, function (err) {
      S.reconfiguring = false;
      emit('reconfiguring', false);
      throw err;
    });
  }

  /* --------------------------------------------------------------- loop */
  function tick(ts) {
    if (!S.running) return;
    S.raf = requestAnimationFrame(tick);

    var interval = Math.floor(1000 / S.fps);
    if (!S.lastTs) S.lastTs = ts;
    if (ts - S.lastTs < interval) return;
    S.lastTs = ts;

    if (S.paused) return;

    /* The encoder stream is momentarily absent while settings are applied —
       skipping is correct, not an error. */
    if (S.reconfiguring || !S.prepared) return;

    var rc = S.mod._cimbare_next_frame(false);
    if (rc < 0) {
      /* A one-off hiccup should not kill the broadcast; only give up if it
         keeps failing, which means something is genuinely wrong. */
      S.frameErrors++;
      if (S.frameErrors > 20) {
        emit('error', new Error('编码器连续失败 (' + rc + ')，已停止广播'));
        stop();
      }
      return;
    }
    S.frameErrors = 0;
    S.mod._cimbare_render();

    /* the encoder restarts the fountain stream once it has emitted 8x the
       required blocks; the counter jumps back to 1, which is our tell */
    if (rc < S.prevCounter) { S.loops++; emit('loop', S.loops); }
    S.prevCounter = rc;

    S.frameCount++;
    emit('tick', {
      frames: S.frameCount,
      loops: S.loops,
      elapsed: (performance.now() - S.startedAt) / 1000,
    });
  }

  function start() {
    if (!S.prepared) return Promise.reject(new Error('尚未准备要发送的内容'));
    if (S.running) return Promise.resolve();

    S.running = true;
    S.paused = false;
    S.frameCount = 0;
    S.loops = 0;
    S.prevCounter = 0;
    S.lastTs = 0;
    S.frameErrors = 0;
    S.startedAt = performance.now();
    requestWakeLock();
    S.raf = requestAnimationFrame(tick);
    emit('started', null);
    return Promise.resolve();
  }

  function pause(on_) {
    S.paused = on_ === undefined ? !S.paused : !!on_;
    emit('paused', S.paused);
  }

  function stop() {
    S.running = false;
    S.paused = false;
    cancelAnimationFrame(S.raf);
    releaseWakeLock();
    emit('stopped', null);
  }

  function clear() {
    stop();
    S.blob = null;
    S.fileName = '';
    S.fileSize = 0;
    S.prepared = false;
    emit('cleared', null);
  }

  /* ---------------------------------------------------------- wake lock */
  function requestWakeLock() {
    if (!navigator.wakeLock || S.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      S.wakeLock = l;
      l.addEventListener('release', function () { S.wakeLock = null; });
    }).catch(function () { /* not fatal */ });
  }
  function releaseWakeLock() {
    if (S.wakeLock) { try { S.wakeLock.release(); } catch (e) { } S.wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.running && !S.paused) requestWakeLock();
  });

  /* -------------------------------------------------------------- export */
  global.AirCimbarSender = {
    state: S,
    on: on,
    off: off,
    init: function (canvas) { S.canvas = canvas; },
    ensureWasm: ensureWasm,
    setMode: setMode,
    setCompression: setCompression,
    setFps: setFps,
    setRotate: setRotate,
    prepare: prepare,
    start: start,
    pause: pause,
    stop: stop,
    clear: clear,
    MAX_PAYLOAD: MAX_PAYLOAD,
  };
})(window);
