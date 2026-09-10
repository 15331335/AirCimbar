#!/usr/bin/env node
/**
 * Run the whole AirCimbar verification suite.
 *
 *   node test/run-all.mjs            # everything
 *   node test/run-all.mjs --quick    # skip the slower camera/import paths
 *
 * Every test drives the real application modules against the unmodified
 * upstream libcimbar wasm. No Xcode, cmake or OpenCV required.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes('--quick');

const SUITE = [
  { name: 'wasm loads in Node + mode buffer sizes', file: 'probe.mjs', args: [] },
  { name: 'core encode/decode round trip (Node decoder)', file: 'roundtrip.mjs', args: ['--mode', '68', '--size', '8192', '--frames', '30'] },
  { name: 'core round trip, all four modes', file: 'roundtrip.mjs', args: ['--mode', '4', '--size', '4096', '--frames', '24'] },
  { name: 'real app modules: send.js + cimbar-worker.js', file: 'app-roundtrip.mjs', args: ['--mode', '68', '--size', '61440', '--frames', '40'] },
  { name: 'UI wiring, tabs, controls, no console errors', file: 'ui-smoke.mjs', args: [] },
  { name: 'regression: changing mode/compression mid-broadcast', file: 'reconfigure.mjs', args: [] },
  { name: 'web assets synced into the iOS bundle', file: 'sync-check.mjs', args: [] },
  { name: 'native Swift sources type-check', file: 'swift-typecheck.mjs', args: [] },
  ...(quick ? [] : [
    { name: 'camera path: fake device -> recv.js -> file', file: 'camera-roundtrip.mjs', args: ['--mode', '68', '--size', '61440', '--frames', '40'] },
    { name: 'camera path, mode Bm', file: 'camera-roundtrip.mjs', args: ['--mode', '67', '--size', '20480', '--frames', '30'] },
    { name: 'import path: recorded video -> import.js -> file', file: 'import-roundtrip.mjs', args: ['--mode', '68', '--size', '4096', '--frames', '12'] },
    { name: 'native shell: loopback server + WKWebView, offline', file: 'native-smoke.mjs', args: [] },
    { name: 'pixel-density limits per mode (measurement)', file: 'resolution.mjs', args: ['--sizes', '720,512,360'] },
  ]),
];

const results = [];
for (const t of SUITE) {
  process.stdout.write(`\n${'─'.repeat(72)}\n▶ ${t.name}\n${'─'.repeat(72)}\n`);
  const r = spawnSync(process.execPath, [path.join(here, t.file), ...t.args], { stdio: 'inherit' });
  results.push({ name: t.name, code: r.status });
}

console.log(`\n${'═'.repeat(72)}\nSUMMARY\n${'═'.repeat(72)}`);
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✅' : '❌'}  ${r.name}${ok ? '' : `  (exit ${r.code})`}`);
}
console.log(`\n  ${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
