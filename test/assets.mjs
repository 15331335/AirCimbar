#!/usr/bin/env node
/**
 * Asset integrity: every file the app points at must exist, be the right type,
 * and actually be the size it claims to be.
 *
 * This exists because a stale reference shipped once already: the icon
 * generator was rewritten, `icons/apple-touch-icon.png` stopped being produced,
 * but index.html, sw.js and serve.mjs all still pointed at it — and iOS reacts
 * to a missing home screen icon by showing a generic letter tile, which is a
 * failure you only notice by staring at a phone.
 *
 * Checks:
 *   * html  href/src, manifest icons, sw.js precache list, and the iOS icon
 *     links all resolve to files that exist
 *   * PNGs decode (signature + IHDR) and match any declared `sizes`
 *   * the icons iOS probes at the web root are present
 *   * app-icons meant for iOS carry no alpha channel
 *
 *   node test/assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'app');
const problems = [];

const read = (p) => fs.readFileSync(path.join(appDir, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(appDir, p));

/* ------------------------------------------------------------- PNG header */
function pngInfo(file) {
  const buf = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 26 || !sig.every((b, i) => buf[i] === b)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

/* ------------------------------------------------------- collect references */
const referenced = new Map();   // relPath -> why

const html = read('index.html');
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const url = m[1];
  if (/^(https?:|data:|#|mailto:)/.test(url)) continue;
  referenced.set(url.replace(/^\.?\//, ''), 'index.html');
}

// the icon links specifically, with their declared sizes
const iconLinks = [];
for (const m of html.matchAll(/<link[^>]+rel="(apple-touch-icon(?:-precomposed)?)"[^>]*>/g)) {
  const tag = m[0];
  const href = (tag.match(/href="([^"]+)"/) || [])[1];
  const sizes = (tag.match(/sizes="(\d+)x(\d+)"/) || [])[1];
  if (href) iconLinks.push({ rel: m[1], href: href.replace(/^\.?\//, ''), size: sizes ? Number(sizes) : null, precomposed: m[1].includes('precomposed') });
}

const manifest = JSON.parse(read('manifest.webmanifest'));
for (const icon of manifest.icons || []) {
  referenced.set(icon.src, 'manifest');
  if (!/^\d+x\d+$/.test(icon.sizes || '')) problems.push(`manifest 图标 ${icon.src} 的 sizes 不合法: ${icon.sizes}`);
}

const sw = read('sw.js');
for (const m of sw.matchAll(/'\.\/([^']+)'/g)) {
  if (m[1]) referenced.set(m[1], 'sw.js 预缓存');
}

/* ----------------------------------------------------------------- verify */
console.log('=== 引用的资源是否存在 ===');
for (const [rel, why] of [...referenced].sort()) {
  if (!exists(rel)) { problems.push(`缺失资源: ${rel}（来自 ${why}）`); continue; }
  const st = fs.statSync(path.join(appDir, rel));
  if (st.size === 0) problems.push(`资源是空文件: ${rel}`);
}

console.log('=== iOS 主屏幕图标 ===');
// iOS probes these two at the site root before honouring the link tag
for (const probe of ['apple-touch-icon.png', 'apple-touch-icon-precomposed.png']) {
  if (!exists(probe)) {
    problems.push(`根目录缺少 ${probe} —— iOS 会退回显示一个字母占位图标`);
    continue;
  }
  const info = pngInfo(path.join(appDir, probe));
  if (!info) { problems.push(`${probe} 不是合法的 PNG`); continue; }
  console.log(`  ${probe}  ${info.width}x${info.height}  colorType=${info.colorType}`);
  if (info.colorType === 6) {
    problems.push(`${probe} 带 alpha 通道，Apple 要求主屏幕图标不带 alpha`);
  }
  if (info.width < 180) problems.push(`${probe} 只有 ${info.width}px，小于 iOS 建议的 180px`);
}

for (const link of iconLinks) {
  const info = pngInfo(path.join(appDir, link.href));
  if (!info) { problems.push(`图标链接指向的不是合法 PNG: ${link.href}`); continue; }
  const where = `${link.rel} ${link.href}`;
  if (link.size && info.width !== link.size) {
    problems.push(`${where} 声明 ${link.size}px 但实际 ${info.width}px`);
  }
  if (link.rel === 'apple-touch-icon' && info.colorType === 6) {
    problems.push(`${where} 带 alpha 通道`);
  }
  console.log(`  ${where}  ->  ${info.width}x${info.height}  ✓`);
}

console.log('=== manifest / 其他图标 ===');
for (const icon of manifest.icons || []) {
  const info = pngInfo(path.join(appDir, icon.src));
  if (!info) { problems.push(`manifest 图标不是合法 PNG: ${icon.src}`); continue; }
  const [w] = icon.sizes.split('x').map(Number);
  if (info.width !== w) problems.push(`manifest 图标 ${icon.src} 声明 ${icon.sizes} 但实际 ${info.width}x${info.height}`);
  console.log(`  ${icon.src}  ${info.width}x${info.height}  purpose=${icon.purpose || 'any'}  ✓`);
}

console.log(`=== 共校验 ${referenced.size} 个引用 + ${iconLinks.length} 个 iOS 图标链接 ===`);
console.log('');
if (problems.length) {
  console.error(`❌ 资源校验失败 (${problems.length}):`);
  for (const p of problems) console.error('   • ' + p);
  process.exit(1);
}
console.log('✅ 资源校验通过 — 所有引用都存在、格式正确、尺寸与声明一致');
process.exit(0);
