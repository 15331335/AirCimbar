/* ==========================================================================
   AirCimbar — wasm worker
   Two roles, each with its own wasm instance (each instance reserves a fixed
   128 MB heap, so the counts are deliberately modest):

     role "scan"  — cimbard_scan_extract_decode: camera frame -> fountain bytes
     role "sink"  — cimbard_fountain_decode + zstd reassembly -> the file

   Everything reconstructing the transfer happens in upstream code; this file
   only marshals buffers across the wasm boundary.
   ========================================================================== */
'use strict';

var VENDOR = '../vendor/';
var GLUE = 'cimbar_js.js';
var WASM = 'cimbar_js.wasm';

var ROLE = 'scan';   // set by the {type:'init'} message

/* ---------------------------------------------------------------- wasm */
var wasmReady = new Promise(function (resolve, reject) {
  self.Module = {
    print: function () { },
    printErr: function () { },
    locateFile: function (p) {
      return new URL(VENDOR + (/\.wasm$/.test(p) ? WASM : p), self.location.href).href;
    },
    onRuntimeInitialized: function () { resolve(self.Module); },
  };
  try {
    importScripts(new URL(VENDOR + GLUE, self.location.href).href);
  } catch (e) { reject(e); }
});

/* ------------------------------------------------------------ role: scan */
var scan = {
  mode: 0,
  imgBuff: null,
  imgPtr: 0,
  fountPtr: 0,
  fountLen: 0,
  repPtr: 0,

  configure: function (mode) {
    var M = self.Module;
    this.mode = mode;
    if (mode > 0) M._cimbard_configure_decode(mode);
    this.ensure(0);
  },

  ensure: function (imgBytes) {
    var M = self.Module;
    if (imgBytes && (!this.imgBuff || imgBytes > this.imgBuff.length)) {
      if (this.imgPtr) M._free(this.imgPtr);
      this.imgPtr = M._malloc(imgBytes);
      this.imgBuff = new Uint8Array(M.HEAPU8.buffer, this.imgPtr, imgBytes);
    } else if (this.imgBuff && this.imgBuff.buffer !== M.HEAPU8.buffer) {
      this.imgBuff = new Uint8Array(M.HEAPU8.buffer, this.imgPtr, this.imgBuff.length);
    }

    if (!this.fountPtr) {
      this.fountLen = M._cimbard_get_bufsize();
      this.fountPtr = M._malloc(this.fountLen);
      this.repPtr = M._malloc(2048);
    }
    return this.imgBuff;
  },

  report: function () {
    var M = self.Module;
    var n = M._cimbard_get_report(this.repPtr, 2048);
    if (n <= 0) return '';
    return new TextDecoder().decode(new Uint8Array(M.HEAPU8.buffer, this.repPtr, n));
  },

  /* pixels: Uint8Array of RGBA (format 4), NV12 (12) or I420 (420) */
  frame: function (pixels, w, h, format, mode) {
    var M = self.Module;
    if (mode && mode !== this.mode) this.configure(mode);

    var buff = this.ensure(pixels.length);
    buff.set(pixels);

    var len = M._cimbard_scan_extract_decode(this.imgPtr, w, h, format, this.fountPtr, this.fountLen);
    if (len === 0) return { type: 'nodata' };
    if (len < 0) return { type: 'fail', code: len, report: this.report() };

    var out = new Uint8Array(M.HEAPU8.buffer, this.fountPtr, len).slice();
    return { type: 'data', buff: out, mode: this.mode };
  },
};

/* ------------------------------------------------------------ role: sink */
var sink = {
  fountPtr: 0,
  fountLen: 0,
  repPtr: 0,
  decPtr: 0,
  decLen: 0,
  mode: 0,
  complete: false,

  configure: function (mode) {
    var M = self.Module;
    this.mode = mode;
    if (mode > 0) M._cimbard_configure_decode(mode);

    var need = M._cimbard_get_bufsize();
    if (need > this.fountLen) {
      if (this.fountPtr) M._free(this.fountPtr);
      this.fountPtr = M._malloc(need);
      this.fountLen = need;
    }
    if (!this.repPtr) this.repPtr = M._malloc(4096);
    return this.fountLen;
  },

  report: function () {
    var M = self.Module;
    var n = M._cimbard_get_report(this.repPtr, 4096);
    if (n <= 0) return null;
    var text = new TextDecoder().decode(new Uint8Array(M.HEAPU8.buffer, this.repPtr, n));
    try { return JSON.parse(text); } catch (e) { return text; }
  },

  push: function (buff) {
    var M = self.Module;
    if (this.complete || !buff.length) return null;
    if (!this.fountPtr) this.configure(this.mode || 68);
    if (buff.length > this.fountLen) return null;

    new Uint8Array(M.HEAPU8.buffer, this.fountPtr, buff.length).set(buff);
    var id = M._cimbard_fountain_decode(this.fountPtr, buff.length);
    /* int64_t arrives as a BigInt; the id itself is a uint32_t */
    if (id > 0) {
      this.complete = true;
      return { type: 'complete', id: Number(BigInt.asUintN(32, id)) };
    }
    return { type: 'progress', report: this.report() };
  },

  /* stream the reassembled + decompressed file out in chunks */
  extract: function (id) {
    var M = self.Module;
    var fnPtr = M._malloc(1024);
    var fnLen = M._cimbard_get_filename(id, fnPtr, 1024);
    var name = fnLen > 0
      ? new TextDecoder().decode(new Uint8Array(M.HEAPU8.buffer, fnPtr, fnLen))
      : 'aircimbar.bin';
    M._free(fnPtr);

    var size = M._cimbard_get_filesize(id);
    this.decLen = M._cimbard_get_decompress_bufsize();
    this.decPtr = M._malloc(this.decLen);

    self.postMessage({ type: 'file-begin', name: name, size: size });

    for (;;) {
      var n = M._cimbard_decompress_read(id, this.decPtr, this.decLen);
      if (n <= 0) break;
      var chunk = new Uint8Array(M.HEAPU8.buffer, this.decPtr, n).slice();
      self.postMessage({ type: 'file-chunk', chunk: chunk }, [chunk.buffer]);
    }
    self.postMessage({ type: 'file-end', name: name });

    M._free(this.decPtr);
    this.decPtr = 0;
  },

  reset: function (mode) {
    this.complete = false;
    this.configure(mode || this.mode || 68);
  },
};

/* --------------------------------------------------------------- plumbing */
self.onmessage = function (ev) {
  var d = ev.data;

  wasmReady.then(function () {
    try {
      if (d.type === 'init') {
        ROLE = d.role;
        if (ROLE === 'scan') scan.configure(d.mode || 0);
        else sink.configure(d.mode || 68);
        self.postMessage({ type: 'ready', role: ROLE, bufsize: ROLE === 'sink' ? sink.fountLen : 0 });
        return;
      }

      if (ROLE === 'scan') {
        if (d.type === 'configure') { scan.configure(d.mode); self.postMessage({ type: 'ready', role: 'scan' }); return; }
        if (d.type === 'frame') {
          var res = scan.frame(new Uint8Array(d.pixels), d.w, d.h, d.format, d.mode);
          if (res.type === 'data') self.postMessage(res, [res.buff.buffer]);
          else self.postMessage(res);
          return;
        }
      }

      if (ROLE === 'sink') {
        if (d.type === 'configure') { sink.reset(d.mode); self.postMessage({ type: 'ready', role: 'sink', bufsize: sink.fountLen }); return; }
        if (d.type === 'reset') { sink.reset(d.mode); return; }
        if (d.type === 'data') {
          var out = sink.push(new Uint8Array(d.buff));
          if (!out) return;
          if (out.type === 'complete') {
            self.postMessage({ type: 'complete', id: out.id });
            sink.extract(out.id);
          } else {
            self.postMessage(out);
          }
          return;
        }
      }

      self.postMessage({ type: 'error', message: 'unknown message ' + d.type });
    } catch (e) {
      self.postMessage({ type: 'error', message: String(e && e.stack || e) });
    }
  }).catch(function (e) {
    self.postMessage({ type: 'error', message: 'wasm init failed: ' + String(e) });
  });
};
