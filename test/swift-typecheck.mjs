#!/usr/bin/env node
/**
 * Type-check the native Swift sources.
 *
 * Uses the macOS SDK that ships with the command line tools, which is enough
 * to catch API misuse, wrong signatures and type errors in the whole shell
 * (LocalHTTPServer, the WKWebView container, the bridge, the SwiftUI views).
 * It is not a substitute for an iOS build, but it means the project is never
 * committed in a state that obviously does not compile.
 *
 * Skips cleanly when swiftc is unavailable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const srcDir = path.join(root, 'native', 'AirCimbar');

if (spawnSync('which', ['swiftc'], { encoding: 'utf8' }).status !== 0) {
  console.log('⏭  swiftc not available — skipping the Swift type-check');
  process.exit(0);
}

const sources = fs.readdirSync(srcDir)
  .filter((f) => f.endsWith('.swift'))
  .sort()
  .map((f) => path.join(srcDir, f));

if (!sources.length) {
  console.error('❌ no Swift sources found in native/AirCimbar');
  process.exit(1);
}

const moduleCache = path.join(os.tmpdir(), 'aircimbar-swift-module-cache');
fs.mkdirSync(moduleCache, { recursive: true });

const res = spawnSync('swiftc', [
  '-typecheck',
  '-module-cache-path', moduleCache,
  ...sources,
], { encoding: 'utf8', timeout: 300000 });

const errors = (res.stderr || '').split('\n').filter((l) => l.includes(': error:'));
const warnings = (res.stderr || '').split('\n').filter((l) => l.includes(': warning:'));

console.log(`▶ type-checked ${sources.length} Swift file(s)`);

if (errors.length) {
  console.error(`\n❌ ${errors.length} error(s):`);
  for (const e of errors.slice(0, 30)) console.error('   ' + e);
  process.exit(1);
}

if (warnings.length) {
  console.log(`⚠️  ${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 10)) console.log('   ' + w);
}

console.log('✅ native Swift sources type-check cleanly');
process.exit(0);
