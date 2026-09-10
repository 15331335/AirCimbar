#!/usr/bin/env node
/** Fail if native/AirCimbar/web has drifted from app/. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [path.join(here, '..', 'tools', 'sync-web.mjs'), '--check'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
