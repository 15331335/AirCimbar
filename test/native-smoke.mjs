#!/usr/bin/env node
/**
 * Native shell smoke test.
 *
 * Compiles the real LocalHTTPServer + a WKWebView harness and runs them,
 * proving that the pieces the iOS app is built from actually work:
 *
 *   * the bundled web app is served over loopback (no network)
 *   * WKWebView loads and runs it
 *   * the libcimbar wasm engine initialises inside WebKit
 *   * the JS <-> native bridge carries ready / keepAwake / file messages
 *
 * Requires a Swift compiler but not Xcode and not the iOS SDK, so it runs on
 * a plain macOS box. Skips cleanly if swiftc is unavailable.
 *
 *   node test/native-smoke.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const which = spawnSync('which', ['swiftc'], { encoding: 'utf8' });
if (which.status !== 0) {
  console.log('⏭  swiftc not available — skipping the native smoke test');
  process.exit(0);
}

// The harness reads the synced bundle, so make sure it is current first.
const sync = spawnSync(process.execPath, [path.join(root, 'tools', 'sync-web.mjs')], { encoding: 'utf8' });
if (sync.status !== 0) {
  process.stdout.write(sync.stdout || '');
  process.stderr.write(sync.stderr || '');
  console.error('❌ could not sync the web assets into native/AirCimbar/web');
  process.exit(1);
}

const webRoot = path.join(root, 'native', 'AirCimbar', 'web');
if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
  console.error('❌ native/AirCimbar/web/index.html missing');
  process.exit(1);
}

// A writable module cache: the default one may not be writable in a sandbox.
const moduleCache = path.join(os.tmpdir(), 'aircimbar-swift-module-cache');
fs.mkdirSync(moduleCache, { recursive: true });

const binary = path.join(os.tmpdir(), `aircimbar-native-smoke-${process.pid}`);
const sources = [
  path.join(root, 'native', 'AirCimbar', 'LocalHTTPServer.swift'),
  path.join(root, 'test', 'native-smoke', 'main.swift'),
];

console.log('▶ compiling the native harness…');
const build = spawnSync('swiftc', [
  '-O', '-module-cache-path', moduleCache, '-o', binary, ...sources,
], { encoding: 'utf8', timeout: 300000 });

if (build.status !== 0) {
  console.error('❌ swiftc failed:\n' + (build.stderr || '').split('\n').slice(0, 25).join('\n'));
  process.exit(1);
}

// WebKit wants to write caches under the user's home; point it somewhere
// writable so the run is not polluted by sandbox denials.
const sandboxHome = path.join(os.tmpdir(), 'aircimbar-native-smoke-home');
fs.mkdirSync(sandboxHome, { recursive: true });

console.log('▶ running the native harness…');
const run = spawnSync(binary, [webRoot], {
  encoding: 'utf8',
  timeout: 240000,
  env: { ...process.env, CFFIXED_USER_HOME: sandboxHome },
});

// WebKit logs cache-directory complaints at startup; they are noise.
const noise = /could not create directory|WebKit\/|SecItemCopyMatching|CoreAnalytics/;
const stdout = (run.stdout || '').split('\n').filter((l) => l && !noise.test(l));
const stderr = (run.stderr || '').split('\n').filter((l) => l && !noise.test(l));

for (const line of stdout) console.log(line);
for (const line of stderr.slice(0, 10)) console.error(line);

if (!process.argv.includes('--keep')) { try { fs.unlinkSync(binary); } catch { } }
process.exit(run.status === 0 ? 0 : 1);
