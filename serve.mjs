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

  const local = {
    cert: path.join(here, 'certs', 'aircimbar-local.pem'),
    key: path.join(here, 'certs', 'aircimbar-local.key'),
  };
  // Preferred: our own CA, whose SAN actually contains this machine's LAN IP,
  // so the phone sees no certificate warning at all.
  if (fs.existsSync(local.cert) && fs.existsSync(local.key)) return local;

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

const CA_PROFILE = path.join(here, 'certs', 'aircimbar-ca.mobileconfig');

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

  const peer = (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    console.log(`  ${peer.padEnd(15)} ${String(res.statusCode).padEnd(4)} ${req.method.padEnd(4)} ${rel}  ${ms}ms`);
  });

  /* The iPhone needs the local CA to trust this server. Handing it out here
     means the whole setup can be done from the phone's browser. iOS wants
     this exact content type to offer the profile installer. */
  if (rel === '/aircimbar-ca.mobileconfig') {
    if (!fs.existsSync(CA_PROFILE)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('还没有生成描述文件，请先在电脑上运行：\n\n  python3 tools/make-local-ca.py\n');
    }
    const body = fs.readFileSync(CA_PROFILE);
    res.writeHead(200, {
      'content-type': 'application/x-apple-aspen-config',
      'content-length': body.length,
      'content-disposition': 'attachment; filename="aircimbar-ca.mobileconfig"',
    });
    return res.end(body);
  }

  /* iOS probes these at the site root regardless of the <link rel=...> tag;
     without them the log fills with confusing 404s during "Add to Home Screen". */
  const ALIASES = {
    /* /apple-touch-icon.png and -precomposed.png are real files at the web
       root (iOS probes them before honouring the link tag), so only the
       favicon still needs mapping. */
    '/favicon.ico': '/icons/icon-192.png',
  };
  if (ALIASES[rel]) rel = ALIASES[rel];

  /* ---------------------------------------------------------- IPA hosting
     Sideloading is much less fiddly if the phone can just fetch the build.
     Drop the artifact from CI into ./dist and it becomes installable from the
     device itself (SideStore: sidestore://install?url=...). */
  if (rel === '/install.ipa' || rel === '/install') {
    const dir = path.join(here, 'dist');
    const ipa = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ipa')).sort().pop()
      : null;

    if (rel === '/install.ipa') {
      if (!ipa) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('还没有 IPA。\n\n把 GitHub Actions 的构建产物放到：\n  ' + dir + '/\n');
      }
      const body = fs.readFileSync(path.join(dir, ipa));
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        'content-disposition': 'attachment; filename="' + ipa + '"',
      });
      return res.end(body);
    }

    const host = req.headers.host || ('127.0.0.1:' + PORT);
    const ipaURL = `https://${host}/install.ipa`;
    const page = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>安装 AirCimbar</title>
<style>body{font:16px/1.7 -apple-system,sans-serif;margin:0;padding:24px;background:#0b1220;color:#e8eefc}
a.btn{display:block;background:#2563eb;color:#fff;text-decoration:none;text-align:center;
padding:16px;border-radius:14px;font-weight:700;margin:18px 0}
code{background:#1a2438;padding:2px 6px;border-radius:6px;font-size:13px;word-break:break-all}
.warn{background:#2a1416;color:#fca5a5;padding:12px;border-radius:12px;font-size:14px}</style>
<h2>安装 AirCimbar</h2>
${ipa ? `<p>找到构建产物：<code>${ipa}</code></p>
<a class="btn" href="sidestore://install?url=${encodeURIComponent(ipaURL)}">用 SideStore 安装</a>
<p>没有反应的话，在 SideStore 里手动添加这个地址：</p>
<p><code>${ipaURL}</code></p>`
      : `<div class="warn">还没有 IPA。把 GitHub Actions 的构建产物放进电脑上的<br><code>${dir}/</code><br>然后刷新本页。</div>`}
<hr><p style="color:#93a3bf;font-size:13px">也可以用数据线 + Sideloadly 安装同一个文件。</p>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
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
let c = null;
if (USE_HTTP) {
  server = http.createServer(handler);
} else {
  c = findCert();
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

  if (USE_HTTP) {
    console.log('');
    console.log('  ⚠ http 模式下 iPhone 无法调用摄像头（非安全上下文），仅用于桌面调试。');
  } else if (lan.length) {
    const ip = lan[0].address;
    const usingLocalCa = !!(c && c.cert.includes('aircimbar-local'));
    console.log('');
    console.log('  在 iPhone 上打开:');
    for (const l of lan) console.log(`    ${scheme}://${l.address}:${PORT}/   (${l.name})`);
    console.log('');
    if (usingLocalCa && fs.existsSync(CA_PROFILE)) {
      console.log('  第一次要在手机上装一次证书，之后永不弹警告:');
      console.log(`    1. 手机浏览器打开  ${scheme}://${ip}:${PORT}/aircimbar-ca.mobileconfig`);
      console.log('       （这一步会先弹一次证书警告，点「显示详细信息 → 访问此网站」继续）');
      console.log('    2. 设置 → 通用 → VPN与设备管理 → 安装该描述文件');
      console.log('    3. 设置 → 通用 → 关于本机 → 证书信任设置 → 打开 AirCimbar Local CA 的开关');
      console.log(`    4. 再打开 ${scheme}://${ip}:${PORT}/ ，不再有任何警告`);
    } else {
      console.log('  当前使用的证书不是本机 CA。还想彻底去掉警告的话:');
      console.log('    python3 tools/make-local-ca.py && node serve.mjs');
    }
  } else {
    console.log('  (未检测到局域网地址)');
  }
  console.log('');
});
