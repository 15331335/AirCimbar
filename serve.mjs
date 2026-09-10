#!/usr/bin/env node
/**
 * AirCimbar — static HTTPS server for the PWA.
 *
 * iOS only grants camera access and service-worker/PWA privileges in a
 * *secure context*, so a plain http:// LAN address is not good enough for an
 * iPhone. This serves ./app over TLS using the Let's Encrypt certificate that
 * already lives in ../certs (linyango.cn), which every device trusts.
 *
 *   node serve.mjs                     # https://<this-host>:8443
 *   node serve.mjs --port 8443
 *   node serve.mjs --cert other.pem --key other.key
 *   node serve.mjs --http              # plain http, for desktop testing only
 *
 * Camera access will NOT work over --http on an iPhone.
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, 'app');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };

const PORT = parseInt(arg('port', '8443'), 10);
const USE_HTTP = argv.includes('--http');

/* Prefer this project's own certs, fall back to the workspace ones that
   already exist next to the dsh setup. */
function findCert() {
  const explicitCert = arg('cert', null);
  const explicitKey = arg('key', null);
  if (explicitCert && explicitKey) return { cert: explicitCert, key: explicitKey };

  const candidates = [
    { dir: path.join(here, 'certs'), base: 'linyango.cn' },
    { dir: path.join(here, '..', 'certs'), base: 'linyango.cn' },
    { dir: '/etc/letsencrypt/live/linyango.cn', base: 'fullchain' },
  ];
  for (const c of candidates) {
    const cert = path.join(c.dir, c.base + (c.base === 'fullchain' ? '.pem' : '.fullchain.pem'));
    const key = path.join(c.dir, c.base === 'fullchain' ? 'privkey.pem' : c.base + '.key');
    if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function handler(req, res) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); return res.end('bad request');
  }
  if (rel === '/') rel = '/index.html';

  const file = path.normalize(path.join(appDir, rel));
  if (!file.startsWith(appDir)) { res.writeHead(403); return res.end('forbidden'); }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + rel);
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      /* the service worker owns offline caching; always revalidate on the wire */
      'cache-control': 'no-cache',
      /* needed so getUserMedia isn't blocked by a restrictive default policy */
      'permissions-policy': 'camera=*, microphone=()',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

let server;
if (USE_HTTP) {
  server = http.createServer(handler);
} else {
  const c = findCert();
  if (!c) {
    console.error('✗ 找不到 TLS 证书。请用 --cert/--key 指定，或先用 --http（iPhone 摄像头将不可用）。');
    process.exit(1);
  }
  server = https.createServer({
    cert: fs.readFileSync(c.cert),
    key: fs.readFileSync(c.key),
  }, handler);
  console.log(`TLS 证书: ${c.cert}`);
}

server.listen(PORT, '0.0.0.0', () => {
  const scheme = USE_HTTP ? 'http' : 'https';
  const lan = lanAddresses();
  console.log('');
  console.log(`  AirCimbar 已启动  (${scheme}, 端口 ${PORT})`);
  console.log('');
  console.log('  在本机打开:');
  console.log(`    ${scheme}://localhost:${PORT}/`);
  if (lan.length) {
    console.log('');
    console.log('  在 iPhone 上打开:');
    for (const l of lan) console.log(`    ${scheme}://${l.address}:${PORT}/   (${l.name})`);
    if (!USE_HTTP) {
      console.log('');
      console.log('  证书签发给 linyango.cn，用 IP 访问会提示证书不受信任。两种做法:');
      console.log(`    a) 用域名访问: ${scheme}://linyango.cn:${PORT}/  （需路由器把 ${PORT} 端口转发到本机 ${lan[0].address}）`);
      console.log('    b) 用 IP 访问并在 Safari 中「显示详细信息 → 访问此网站」，之后摄像头同样可用');
    }
  } else {
    console.log('  (未检测到局域网地址)');
  }
  if (USE_HTTP) {
    console.log('');
    console.log('  ⚠ http 模式下 iPhone 无法调用摄像头（非安全上下文），仅用于桌面调试。');
  }
  console.log('');
});
