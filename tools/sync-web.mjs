#!/usr/bin/env node
/**
 * Mirror the web app into the iOS bundle.
 *
 *   node tools/sync-web.mjs [--check]
 *
 * `app/` is the single source of truth — the exact bytes verified by the test
 * suite are what get copied into native/AirCimbar/web/, so the PWA and the
 * native app can never drift apart. `--check` verifies the copy is current
 * without writing (used by CI and by the test suite).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SRC = path.join(root, 'app');
const DST = path.join(root, 'native', 'AirCimbar', 'web');

const checkOnly = process.argv.includes('--check');

/** Files the native app has no use for. */
const SKIP = new Set(['.DS_Store']);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const wanted = walk(SRC);
const problems = [];
let copied = 0;

if (!checkOnly) fs.mkdirSync(DST, { recursive: true });

// copy / verify every source file
for (const rel of wanted) {
  const from = path.join(SRC, rel);
  const to = path.join(DST, rel);
  const same = fs.existsSync(to) && sha(from) === sha(to);
  if (same) continue;

  if (checkOnly) {
    problems.push(fs.existsSync(to) ? `stale: ${rel}` : `missing: ${rel}`);
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied++;
  }
}

// prune anything in the destination that no longer exists in app/
if (fs.existsSync(DST)) {
  for (const rel of walk(DST)) {
    if (wanted.includes(rel)) continue;
    if (checkOnly) problems.push(`extra: ${rel}`);
    else { fs.unlinkSync(path.join(DST, rel)); copied++; }
  }
}

if (checkOnly) {
  if (problems.length) {
    console.error(`❌ native/AirCimbar/web is out of date (${problems.length} file(s)):`);
    for (const p of problems.slice(0, 20)) console.error('   • ' + p);
    if (problems.length > 20) console.error(`   … and ${problems.length - 20} more`);
    console.error('\n   run: node tools/sync-web.mjs');
    process.exit(1);
  }
  console.log(`✅ native/AirCimbar/web is in sync (${wanted.length} files)`);
  process.exit(0);
}

const bytes = wanted.reduce((n, rel) => n + fs.statSync(path.join(SRC, rel)).size, 0);
console.log(`✅ synced ${wanted.length} files (${(bytes / 1048576).toFixed(2)} MB) -> native/AirCimbar/web/`);
if (copied) console.log(`   ${copied} file(s) updated`);
else console.log('   already up to date');
