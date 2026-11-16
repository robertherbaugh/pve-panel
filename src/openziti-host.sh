#!/bin/bash
# The guest agent supplies the one-time enrollment JWT on stdin, never argv.
set -euo pipefail
umask 077
service_id='__SERVICE_ID__'
identity_id='__IDENTITY_ID__'
root=/var/lib/rcadea-ziti
install -d -m 700 "$root/$service_id"
exec 9>"$root/$service_id/install.lock"
flock -n 9 || exit 75
identity="$root/$service_id/identity.json"
marker="$root/$service_id/controller-identity"
unit="rcadea-ziti-host@$service_id.service"
if [ -s "$identity" ] && [ "$(cat "$marker" 2>/dev/null)" = "$identity_id" ]; then
  systemctl enable --now "$unit" >/dev/null 2>&1
  systemctl is-active --quiet "$unit"
  exit 0
fi
test ! -e "$identity" || exit 76
command -v python3 >/dev/null
command -v systemctl >/dev/null
if command -v cloud-init >/dev/null; then
  cloud-init status --wait >/dev/null 2>&1 || [ "$?" -eq 2 ]
fi
scratch=$(mktemp -d /run/rcadea-ziti.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
cat >"$scratch/enrollment.jwt"
test -s "$scratch/enrollment.jwt"
install -d -m 755 /usr/local/lib/rcadea-ziti/1.20.0
python3 - "$scratch" <<'PY'
import hashlib, io, os, platform, sys, urllib.request, zipfile
digests = {
  'x86_64': '2643d3bdb22a29587b07d93f008d2171a385ca3046c5909bbced6c19cebd3a2c',
  'aarch64': '3f1e74dc1dbfdd99ce9ff11d5987e1a8f94b8f0a0b17f8375aabffd738b64fb1',
}
arch = platform.machine()
if arch not in digests: raise SystemExit('Unsupported guest architecture')
asset = 'arm64' if arch == 'aarch64' else arch
url = f'https://github.com/openziti/ziti-tunnel-sdk-c/releases/download/v1.20.0/ziti-edge-tunnel-Linux_{asset}.zip'
with urllib.request.urlopen(url, timeout=60) as response:
    archive = response.read(64 * 1024 * 1024)
if hashlib.sha256(archive).hexdigest() != digests[arch]: raise SystemExit('Download verification failed')
with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
    names = [n for n in bundle.namelist() if n.rstrip('/').split('/')[-1] == 'ziti-edge-tunnel' and not n.endswith('/')]
    if len(names) != 1: raise SystemExit('Unexpected archive contents')
    binary = '/usr/local/lib/rcadea-ziti/1.20.0/ziti-edge-tunnel.new'
    with open(binary, 'wb') as output: output.write(bundle.read(names[0]))
    os.chmod(binary, 0o755)
    os.replace(binary, binary.removesuffix('.new'))
PY
/usr/local/lib/rcadea-ziti/1.20.0/ziti-edge-tunnel enroll \
  --jwt "$scratch/enrollment.jwt" --identity "$scratch/identity.json" >/dev/null 2>&1
test -s "$scratch/identity.json"
printf '%s\n' "$identity_id" >"$marker"
install -m 600 "$scratch/identity.json" "$identity"
cat >/etc/systemd/system/rcadea-ziti-host@.service <<'UNIT'
[Unit]
Description=RCADEA OpenZiti VM service %i
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/lib/rcadea-ziti/1.20.0/ziti-edge-tunnel run-host -i /var/lib/rcadea-ziti/%i/identity.json
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/rcadea-ziti/%i
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now "$unit" >/dev/null 2>&1
systemctl is-active --quiet "$unit"
