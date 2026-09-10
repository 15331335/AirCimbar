/* ==========================================================================
   AirCimbar — shared engine core
   Thin, honest wrapper around the *official* libcimbar WebAssembly build.

   Nothing here re-implements the transfer format: encoding, Reed-Solomon
   error correction, interleaving, wirehair fountain codes and zstd framing
   all come from the upstream wasm module. This file only knows how to talk
   to it.

   The mode numbers, buffer sizes and call sequences below were verified
   end-to-end against libcimbar v0.6.8 in the browser (see test/roundtrip.mjs).
   ========================================================================== */
(function (global) {
  'use strict';

  var VENDOR = 'vendor/';
  var GLUE = 'cimbar_js.js';
  var WASM = 'cimbar_js.wasm';

  /* ---------------------------------------------------------------- modes
     `bytesPerFrame` is exactly what the engine reports via
     _cimbard_get_bufsize() and equals chunksPerFrame * chunkSize.
     `legacy: true` modes are the 0.5.x-era palettes, kept for compatibility
     with older cimbar clients. */
  var MODES = {
    68: {
      id: 68, key: 'B', name: '标准 B', legacy: false,
      cells: '112 × 112', bitsPerCell: 6, capacity: 9300, ecc: '30 / 155',
      chunksPerFrame: 12, chunkSize: 625, bytesPerFrame: 7500,
      note: '默认模式，密度与稳健性最均衡',
    },
    67: {
      id: 67, key: 'Bm', name: '宽屏 Bm', legacy: false,
      cells: '112 × 78', bitsPerCell: 6, capacity: 6444, ecc: '36 / 179',
      chunksPerFrame: 12, chunkSize: 429, bytesPerFrame: 5148,
      note: '16:9 长条，铺满横屏显示器',
    },
    66: {
      id: 66, key: 'Bu', name: '微型 Bu', legacy: false,
      cells: '80 × 69', bitsPerCell: 6, capacity: 4032, ecc: '33 / 168',
      chunksPerFrame: 6, chunkSize: 540, bytesPerFrame: 3240,
      note: '码更小，远距离 / 低分辨率摄像头更稳',
    },
    4: {
      id: 4, key: '4C', name: '兼容 4C', legacy: true,
      cells: '112 × 112', bitsPerCell: 6, capacity: 9300, ecc: '30 / 155',
      chunksPerFrame: 10, chunkSize: 750, bytesPerFrame: 7500,
      note: '0.5.x 旧调色板，兼容旧版客户端',
    },
    8: {
      id: 8, key: '8C', name: '旧版 8C', legacy: true,
      cells: '112 × 112', bitsPerCell: 7, capacity: 10850, ecc: '30 / 155',
      chunksPerFrame: 10, chunkSize: 875, bytesPerFrame: 8750,
      note: '0.5.x 八色旧调色板',
    },
  };

  /* Receiver autodetect order — same rotation upstream uses. */
  var AUTO_ORDER = [68, 67, 66, 4];

  var SEND_MODES = [68, 67, 66, 4];
  var RECV_MODES = [0, 68, 67, 66, 4];

  /* ---------------------------------------------------------------- utils */
  function vendorURL(name) {
    return new URL(VENDOR + name, document.baseURI).href;
  }

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function fmtRate(bytesPerSec) {
    if (!bytesPerSec || !isFinite(bytesPerSec)) return '—';
    return fmtBytes(bytesPerSec) + '/s';
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2600);
  }

  /* Build the Emscripten Module config. The glue script is loaded *after*
     this object is on `window.Module`, because it reads Module.canvas during
     initialisation. */
  function moduleConfig(canvas, onReady, onLog) {
    return {
      canvas: canvas || undefined,
      print: function (s) { if (onLog) onLog(s); },
      printErr: function (s) { if (onLog) onLog(s); },
      /* upstream bakes a build-timestamped wasm filename into the glue; map it
         onto our stable vendored name */
      locateFile: function (pathName) {
        if (/\.wasm$/.test(pathName)) return vendorURL(WASM);
        return vendorURL(pathName);
      },
      onRuntimeInitialized: function () { onReady(this); },
    };
  }

  /* Load the glue in the main thread. Must be called with window.Module
     already assigned. */
  function loadGlue() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = vendorURL(GLUE);
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('无法加载 cimbar_js.js')); };
      document.head.appendChild(s);
    });
  }

  /* ------------------------------------------------------- webgl readback
     drawImage() off a WebGL canvas whose preserveDrawingBuffer is false
     returns an empty frame, so read the framebuffer directly. GL rows run
     bottom-up; the decoder wants top-down. */
  function readGLFrame(mod, w, h) {
    var gl = mod.ctx;
    if (!gl) return null;
    var raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    var rowBytes = w * 4;
    var out = new Uint8Array(raw.length);
    for (var y = 0; y < h; y++) {
      out.set(raw.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes);
    }
    return out;
  }

  global.AirCimbar = {
    VENDOR: VENDOR,
    GLUE: GLUE,
    WASM: WASM,
    MODES: MODES,
    AUTO_ORDER: AUTO_ORDER,
    SEND_MODES: SEND_MODES,
    RECV_MODES: RECV_MODES,
    vendorURL: vendorURL,
    fmtBytes: fmtBytes,
    fmtRate: fmtRate,
    toast: toast,
    moduleConfig: moduleConfig,
    loadGlue: loadGlue,
    readGLFrame: readGLFrame,
  };
})(window);
