#!/bin/bash
# Enrollment material arrives on guest-agent stdin, never in command arguments.
set -euo pipefail
umask 077
account_id='__ACCOUNT_ID__'
root=/var/lib/rcadea-zrok
install -d -m 700 "$root/$account_id"
exec 9>"$root/$account_id/install.lock"
flock -n 9 || exit 75
scratch=$(mktemp -d /run/rcadea-zrok.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
cat >"$scratch/bootstrap.json"
command -v python3 >/dev/null
command -v systemctl >/dev/null
if command -v cloud-init >/dev/null; then
  cloud-init status --wait >/dev/null 2>&1 || [ "$?" -eq 2 ]
fi
install -d -m 755 /usr/local/lib/rcadea-zrok/2.0.9
python3 - "$scratch/bootstrap.json" "$root/$account_id" <<'PY'
import hashlib, io, json, os, platform, sys, tarfile, urllib.request
digests = {
 'x86_64':'cce814e1f0036ea9bd6fc58363bd2b52468db903781d44defcf755349fca333f',
 'aarch64':'2a103f6ebcc793dff840b781ac6459ee6dbec14a4c63a8ff0f6089081055c34d',
}
arch = platform.machine()
if arch not in digests: raise SystemExit('Unsupported guest architecture')
asset = 'amd64' if arch == 'x86_64' else 'arm64'
url = f'https://github.com/openziti/zrok/releases/download/v2.0.9/zrok_2.0.9_linux_{asset}.tar.gz'
with urllib.request.urlopen(url, timeout=60) as response:
 archive = response.read(128*1024*1024)
if hashlib.sha256(archive).hexdigest() != digests[arch]: raise SystemExit('Download verification failed')
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
 files = [m for m in bundle.getmembers() if m.isfile() and m.name.rstrip('/').split('/')[-1] == 'zrok2']
 if len(files) != 1: raise SystemExit('Unexpected release contents')
 binary = '/usr/local/lib/rcadea-zrok/2.0.9/zrok2.new'
 with open(binary, 'wb') as output: output.write(bundle.extractfile(files[0]).read())
 os.chmod(binary, 0o755)
 os.replace(binary, binary.removesuffix('.new'))
with open(sys.argv[1]) as f: data = json.load(f)
root = sys.argv[2] + '/.zrok2'
os.makedirs(root + '/identities', mode=0o700, exist_ok=True)
def write(name, value):
 path = root + '/' + name
 if os.path.exists(path):
  with open(path) as f: current = json.load(f)
  if name == 'environment.json' and current != value: raise SystemExit('Agent identity mismatch')
 with open(path + '.new', 'w') as f: json.dump(value, f)
 os.chmod(path + '.new', 0o600)
 os.replace(path + '.new', path)
write('metadata.json', {'v':'v0.4'})
write('environment.json', {'zrok_token':data['accountToken'], 'ziti_identity':data['identity'], 'api_endpoint':data['apiEndpoint']})
write('identities/environment.json', json.loads(data['cfg']))
write('agent-enrollment.json', {'v':'1', 'token':data['enrollmentToken']})
PY
cat >/etc/systemd/system/rcadea-zrok-agent@.service <<'UNIT'
[Unit]
Description=RCADEA zrok sharing agent %i
After=network-online.target
Wants=network-online.target
[Service]
Environment=HOME=/var/lib/rcadea-zrok/%i
ExecStartPre=/usr/bin/rm -f /var/lib/rcadea-zrok/%i/.zrok2/agent.socket
ExecStart=/usr/local/lib/rcadea-zrok/2.0.9/zrok2 agent start
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/rcadea-zrok/%i
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now "rcadea-zrok-agent@$account_id.service" >/dev/null 2>&1
systemctl is-active --quiet "rcadea-zrok-agent@$account_id.service"
