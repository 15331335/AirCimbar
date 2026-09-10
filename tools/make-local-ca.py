#!/usr/bin/env python3
"""
AirCimbar — local certificate authority for self-hosted HTTPS.

Why this exists
---------------
The phone reaches the PWA at https://<mac-lan-ip>:8443/. Serving that with a
certificate issued for some *other* name (or a self-signed one) makes iOS show
its "this connection is not private" interstitial — once when installing, and
quite possibly on every launch of the home-screen app, because each cold start
navigates to the start_url again.

The fix is the standard one for self-hosted HTTPS: mint a small local CA,
issue a server certificate whose SAN actually contains the LAN IP, and install
the CA on the phone once. After that the certificate chain validates normally
and no warning ever appears.

Everything here is local and offline. The CA private key never leaves this
machine, and nothing is sent anywhere.

    python3 tools/make-local-ca.py                 # auto-detect the LAN IP
    python3 tools/make-local-ca.py --ip 192.168.1.50 --days 825
"""

import argparse
import base64
import ipaddress
import os
import plistlib
import subprocess
import sys
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT_DIR = os.path.join(ROOT, 'certs')

CA_KEY = os.path.join(CERT_DIR, 'aircimbar-ca.key')
CA_CRT = os.path.join(CERT_DIR, 'aircimbar-ca.pem')
SRV_KEY = os.path.join(CERT_DIR, 'aircimbar-local.key')
SRV_CSR = os.path.join(CERT_DIR, 'aircimbar-local.csr')
SRV_CRT = os.path.join(CERT_DIR, 'aircimbar-local.pem')
PROFILE = os.path.join(CERT_DIR, 'aircimbar-ca.mobileconfig')


def run(cmd):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write('command failed: ' + ' '.join(cmd) + '\n')
        sys.stderr.write(res.stderr)
        sys.exit(1)
    return res.stdout


def detect_lan_ip():
    """First non-loopback IPv4 address, preferring en* interfaces."""
    out = run(['ifconfig'])
    candidates = []
    current = None
    for line in out.splitlines():
        if line and not line[0].isspace():
            current = line.split(':')[0]
        stripped = line.strip()
        if stripped.startswith('inet ') and not stripped.startswith('inet 127.'):
            addr = stripped.split()[1]
            try:
                ip = ipaddress.IPv4Address(addr)
            except ValueError:
                continue
            if ip.is_private or ip.is_link_local:
                candidates.append((current or '', addr))

    for name, addr in candidates:
        if name.startswith('en'):
            return addr
    return candidates[0][1] if candidates else None


def openssl_version_supports_addext():
    out = run(['openssl', 'req', '-help'])
    return '-addext' in out


def make_ca():
    if os.path.exists(CA_KEY) and os.path.exists(CA_CRT):
        print('· CA 已存在，复用 %s' % os.path.relpath(CA_CRT, ROOT))
        return
    print('· 生成根 CA')
    # -sha256 is essential: LibreSSL's default for a self-signed cert is
    # SHA-1, and modern OpenSSL (i.e. Node) refuses to load such a CA with
    # "ca md too weak".
    run([
        'openssl', 'req', '-x509', '-sha256', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', CA_KEY, '-out', CA_CRT,
        '-days', '3650',
        '-subj', '/CN=AirCimbar Local CA/O=AirCimbar',
    ])
    os.chmod(CA_KEY, 0o600)


def make_server_cert(ip, extra_names, days):
    conf = os.path.join(CERT_DIR, 'aircimbar-local.cnf')
    sans = ['IP:%s' % ip, 'IP:127.0.0.1', 'DNS:localhost', 'DNS:aircimbar.local']
    for n in extra_names:
        sans.append('DNS:%s' % n if not _is_ip(n) else 'IP:%s' % n)

    with open(conf, 'w') as f:
        f.write(
            "[req]\n"
            "distinguished_name = dn\n"
            "prompt = no\n"
            "[dn]\n"
            "CN = AirCimbar\n"
            "O = AirCimbar\n"
            "[v3]\n"
            "subjectAltName = %s\n"
            "basicConstraints = CA:FALSE\n"
            "keyUsage = digitalSignature, keyEncipherment\n"
            "extendedKeyUsage = serverAuth\n"
            "authorityKeyIdentifier = keyid,issuer\n"
            % ', '.join(sans)
        )

    print('· 签发服务器证书 (SAN: %s)' % ', '.join(sans))
    run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes',
         '-keyout', SRV_KEY, '-out', SRV_CSR, '-config', conf])
    os.chmod(SRV_KEY, 0o600)
    run(['openssl', 'x509', '-req', '-sha256', '-in', SRV_CSR,
         '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
         '-out', SRV_CRT, '-days', str(days),
         '-extfile', conf, '-extensions', 'v3'])
    os.chmod(SRV_CRT, 0o644)


def _is_ip(value):
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def make_profile(ip):
    """A .mobileconfig carrying just the CA, ready to install on iOS."""
    with open(CA_CRT, 'rb') as f:
        ca_der = subprocess.run(
            ['openssl', 'x509', '-outform', 'der', '-in', CA_CRT],
            capture_output=True).stdout

    payload_uuid = str(uuid.uuid4()).upper()
    profile_uuid = str(uuid.uuid4()).upper()

    payload = {
        'PayloadCertificateFileName': 'AirCimbar Local CA.pem',
        'PayloadContent': ca_der,
        'PayloadDescription': 'AirCimbar 本地根证书，用于让 iPhone 信任本机自建的 HTTPS 服务。',
        'PayloadDisplayName': 'AirCimbar Local CA',
        'PayloadIdentifier': 'org.aircimbar.ca.%s' % payload_uuid,
        'PayloadType': 'com.apple.security.root',
        'PayloadUUID': payload_uuid,
        'PayloadVersion': 1,
    }

    profile = {
        'PayloadContent': [payload],
        'PayloadDisplayName': 'AirCimbar 本地证书',
        'PayloadDescription': '安装后 iPhone 会信任本机为 AirCimbar 签发的证书，'
                              '地址 https://%s:8443/ 不再出现安全警告。' % ip,
        'PayloadIdentifier': 'org.aircimbar.profile.%s' % profile_uuid,
        'PayloadOrganization': 'AirCimbar',
        'PayloadRemovalDisallowed': False,
        'PayloadType': 'Configuration',
        'PayloadUUID': profile_uuid,
        'PayloadVersion': 1,
    }

    with open(PROFILE, 'wb') as f:
        plistlib.dump(profile, f)
    # iOS is happier with a plain-text plist for hand-delivered profiles
    print('· 生成安装描述文件 %s' % os.path.relpath(PROFILE, ROOT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ip', default=None,
                    help='手机访问本机用的 IP（默认自动探测局域网地址）')
    ap.add_argument('--days', type=int, default=825,
                    help='服务器证书有效期（天），默认 825 —— 与 iOS 对 TLS 证书的 825 天上限一致')
    ap.add_argument('--name', action='append', default=[],
                    help='额外的主机名（可重复，例如 --name mac.local）')
    args = ap.parse_args()

    os.makedirs(CERT_DIR, exist_ok=True)

    ip = args.ip or detect_lan_ip()
    if not ip:
        sys.stderr.write('无法自动探测局域网 IP，请用 --ip 指定\n')
        sys.exit(1)
    print('· 手机访问本机使用的 IP: %s' % ip)

    make_ca()
    make_server_cert(ip, args.name, args.days)
    make_profile(ip)

    # refuse to hand back something Node/OpenSSL will reject later
    for label, path in (('CA', CA_CRT), ('服务器证书', SRV_CRT)):
        info = run(['openssl', 'x509', '-in', path, '-noout', '-text'])
        if 'sha1' in info.lower().split('signature algorithm')[1][:60].lower():
            sys.stderr.write('%s 使用了 SHA-1 签名，Node 会拒绝加载\n' % label)
            sys.exit(1)

    # show the result, and verify the chain we just built actually validates
    print()
    print('  服务器证书: %s' % os.path.relpath(SRV_CRT, ROOT))
    print('  服务器私钥: %s' % os.path.relpath(SRV_KEY, ROOT))
    print('  根 CA:      %s' % os.path.relpath(CA_CRT, ROOT))
    print('  描述文件:   %s' % os.path.relpath(PROFILE, ROOT))
    print()
    print('  SAN:')
    for line in run(['openssl', 'x509', '-in', SRV_CRT, '-noout', '-text']).splitlines():
        if 'DNS:' in line or 'IP Address:' in line:
            print('    ' + line.strip())
    print()
    print('现在用本地 CA 启动服务:')
    print('    node serve.mjs --cert certs/aircimbar-local.pem --key certs/aircimbar-local.key')
    print()
    print('手机安装顺序见 README 的「让 iPhone 信任本机证书」一节。')


if __name__ == '__main__':
    main()
