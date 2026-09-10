// Probe: can the official libcimbar WASM module be instantiated under Node?
// (decoder paths need no WebGL -- we only care about those here)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const glue = path.join(here, '..', 'app', 'vendor', 'cimbar_js.js');

const src = fs.readFileSync(glue, 'utf8');
const logs = [];

const sandbox = {
  Module: {
    print: (s) => logs.push('[out] ' + s),
    printErr: (s) => logs.push('[err] ' + s),
    /* upstream bakes a build-timestamped wasm name into the glue; the vendored
       file uses a stable name, so redirect it */
    locateFile: (p) => path.join(path.dirname(glue), /\.wasm$/.test(p) ? 'cimbar_js.wasm' : p),
  },
  console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
  process,
  require,
  __filename: glue,
  __dirname: path.dirname(glue),
  setTimeout, clearTimeout, setInterval, clearInterval,
  TextDecoder, TextEncoder, performance, fetch, WebAssembly, URL, Buffer,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

const ready = new Promise((resolve, reject) => {
  sandbox.Module.onRuntimeInitialized = () => resolve(sandbox.Module);
  setTimeout(() => reject(new Error('wasm init timeout (20s)')), 20000);
});

try {
  vm.runInContext(src, sandbox, { filename: glue });
  const M = await ready;
  console.log('wasm instantiated in Node: OK');
  console.log('HEAPU8 bytes:', M.HEAPU8 ? M.HEAPU8.length : 'n/a');
  console.log('decode buffsize(68):', M._cimbard_get_bufsize());
  for (const mode of [4, 8, 66, 67, 68]) {
    const r = M._cimbard_configure_decode(mode);
    console.log(`  configure_decode(${mode}) -> ${r}  bufsize=${M._cimbard_get_bufsize()}  decompressBuf=${M._cimbard_get_decompress_bufsize()}`);
  }
  console.log('encode bufsize:', M._cimbare_encode_bufsize());
  console.log('report:', (() => {
    const p = M._malloc(512);
    const n = M._cimbard_get_report(p, 512);
    const s = new TextDecoder().decode(new Uint8Array(M.HEAPU8.buffer, p, n));
    M._free(p);
    return JSON.stringify(s);
  })());
  console.log('--- wasm runtime log tail ---');
  console.log(logs.slice(-8).join('\n') || '(no runtime output)');
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(logs.slice(-12).join('\n'));
  process.exitCode = 1;
}
