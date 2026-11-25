#!/usr/bin/env bash
# Install one production manager under a dedicated, non-root service account.
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: ./install.sh --home /absolute/path [--port 3082] [--capacity 12]
                    [--package /path/dsh-superagent-*.tgz] [--no-start]

Run as the dedicated service account. The installation directory must be new.
The installer uses only the packaged bundle and the existing DSH installation.
BUILD-INFO.json must be next to install.sh and match the selected package.
EOF
}

fail() { printf '%s\n' "$*" >&2; exit 1; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
deploy_home=''
port=3082
capacity=12
archive=''
start=1
while (( $# )); do
  case "$1" in
    --home|--port|--capacity|--package)
      (( $# >= 2 )) || fail "Missing value for $1"
      case "$1" in
        --home) deploy_home=$2 ;;
        --port) port=$2 ;;
        --capacity) capacity=$2 ;;
        --package) archive=$2 ;;
      esac
      shift 2 ;;
    --no-start) start=0; shift ;;
    --offline) shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ "$deploy_home" = /* && "$deploy_home" != / ]] || fail 'A new absolute --home path is required'
[[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] && (( port >= 1024 && port <= 65535 )) || fail '--port must be 1024–65535'
[[ "$capacity" =~ ^([1-9]|1[0-2])$ ]] || fail '--capacity must be 1–12'
[[ $(id -u) != 0 ]] || fail 'Run this installer as a dedicated non-root service account'
for executable in node dsh git tar install awk; do command -v "$executable" >/dev/null || fail "$executable must be installed"; done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major > 24 || (major === 24 && minor >= 9))) process.exit(1)' \
  || fail 'DSH 0.2.2-rc.5 requires Node.js 24.9.0 or newer'
dsh_path=$(command -v dsh)
[[ "$dsh_path" = /* ]] || fail 'dsh must resolve to an absolute executable path'
[[ $("$dsh_path" --version) = 0.2.2-rc.5 ]] || fail 'This release requires DSH 0.2.2-rc.5'

if [[ -z "$archive" ]]; then
  shopt -s nullglob
  archives=("$script_dir"/dsh-superagent-*.tgz)
  (( ${#archives[@]} == 1 )) || fail 'Place one release archive next to install.sh or specify --package'
  archive=${archives[0]}
fi
[[ -f "$archive" && -r "$archive" ]] || fail 'Release archive is missing or unreadable'
[[ -x "$script_dir/dsh-enterprise" ]] || fail 'The release is missing its dsh-enterprise operator executable'

# Resolve the parent before creating anything. The leaf must be new on every install.
deploy_home=$(node -e 'const fs = require("node:fs"), p = require("node:path"); const target = p.resolve(process.argv[1]); if (target === "/") process.exit(1); process.stdout.write(p.join(fs.realpathSync(p.dirname(target)), p.basename(target)))' "$deploy_home") \
  || fail 'The installation parent directory must exist and be accessible'
archive=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$archive")
release_sha=$(node -e 'const fs = require("node:fs"), crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$archive")
node - "$script_dir/BUILD-INFO.json" "$release_sha" <<'NODE'
const fs = require('node:fs');
const [metadata, digest] = process.argv.slice(2);
try {
  let info;
  try { info = JSON.parse(fs.readFileSync(metadata, 'utf8')); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? 'Release verification failed: BUILD-INFO.json is missing next to install.sh' : 'Release verification failed: BUILD-INFO.json is unreadable or invalid JSON'); }
  if (!info || typeof info.pluginVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info.pluginVersion) ||
      info.package !== `dsh-superagent-${info.pluginVersion}.tgz` || !/^[0-9a-f]{64}$/.test(info.packageSha256 ?? '')) {
    throw new Error('Release verification failed: BUILD-INFO.json has invalid package metadata');
  }
  if (info.verifiedDshVersion !== '0.2.2-rc.5') throw new Error('Release verification failed: BUILD-INFO.json requires a different DSH version');
  if (info.packageSha256 !== digest) throw new Error('Release verification failed: package SHA-256 does not match BUILD-INFO.json. Obtain an intact release package before installing.');
} catch (error) { console.error(error.message); process.exit(1); }
NODE
profile=$(node -e 'process.stdout.write("dsh-enterprise-" + require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16))' "$deploy_home")

# This distribution contains only regular files and directories under package/.
tar -tzf "$archive" | awk '$0 !~ /^package(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ { unsafe=1 } END { exit unsafe }' \
  || fail 'Release archive contains an invalid path'
tar -tvzf "$archive" | awk 'substr($0,1,1) !~ /[d-]/ { unsafe=1 } END { exit unsafe }' \
  || fail 'Release archive contains an unsupported file type'
mkdir -m 700 -- "$deploy_home" || fail 'The installation directory already exists or is not writable'
trap 'if [[ ! -f "$deploy_home/service.json" ]]; then printf "Installation incomplete. Read %s/install.log before selecting a fresh directory.\n" "$deploy_home" >&2; fi' EXIT

release="$deploy_home/releases/$release_sha"
log="$deploy_home/install.log"
: > "$log"
mkdir -p -- "$release" "$deploy_home/dsh" "$deploy_home/manager"
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$release" >> "$log" 2>&1
bundle="$release/package"
node - "$bundle" "$script_dir/BUILD-INFO.json" >> "$log" 2>&1 <<'NODE'
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const root = process.argv[2], manifest = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
if (pkg.name !== 'dsh-superagent' || !pkg.dsh?.bundle?.patch) throw new Error('Unexpected release package');
const info = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (pkg.version !== info.pluginVersion) throw new Error('Release package version does not match BUILD-INFO.json');
for (const name of ['lib/index.js', 'lib/client.js', pkg.dsh.bundle.patch]) fs.accessSync(path.join(root, name));
const deployed = createRequire(manifest);
for (const name of ['zod', 'proper-lockfile']) {
  const resolved = fs.realpathSync(deployed.resolve(name));
  if (!resolved.startsWith(path.join(root, 'node_modules') + path.sep)) throw new Error('The release archive is missing its bundled runtime modules');
  deployed(name);
}
NODE

export DSH_HOME="$deploy_home/dsh"
export npm_config_offline=true pnpm_config_offline=true
if ! "$dsh_path" "$profile" --from-default-profile web --dump-config >> "$log" 2>&1; then fail "DSH profile setup failed. Read $log"; fi
if ! "$dsh_path" plugin --profile "$profile" add --offline "link:$bundle" >> "$log" 2>&1; then fail "DSH bundle installation failed. Read $log"; fi
node - "$deploy_home" "$profile" "$port" "$capacity" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [home, profile, port, capacity] = process.argv.slice(2);
const operatorTokenFile = path.join(home, 'operator.token');
fs.writeFileSync(operatorTokenFile, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
const patch = [
  { id: 'webserver', config: { host: '127.0.0.1', port: Number(port) } },
  { id: 'dsh-superagent', config: { mode: 'manager', enterprisePilot: true, requireProtectedBranches: true,
    maxRunningRepositories: Number(capacity), stateDir: path.join(home, 'manager'), operatorTokenFile } },
  { id: 'dsh-superagent-github', disabled: true },
  { id: 'dsh-superagent-feishu', disabled: true },
];
fs.writeFileSync(path.join(home, 'dsh', 'profiles', profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n', { mode: 0o600 });
NODE
if ! "$dsh_path" --profile "$profile" --dump-config >> "$log" 2>&1; then fail "DSH composed profile failed. Read $log"; fi

install -m 700 -- "$script_dir/dsh-enterprise" "$deploy_home/dsh-enterprise"
node - "$deploy_home" "$profile" "$port" "$capacity" "$dsh_path" "$bundle" "$release_sha" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [home, profile, port, capacity, dsh, bundle, sha256] = process.argv.slice(2);
const config = { schema: 1, profile, port: Number(port), capacity: Number(capacity), dsh, bundle, sha256, path: process.env.PATH, operatorTokenFile: path.join(home, 'operator.token') };
fs.writeFileSync(path.join(home, 'service.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
NODE
printf 'Installed %s\nOperator command: %s/dsh-enterprise\nToken file: %s/operator.token\n' "$deploy_home" "$deploy_home" "$deploy_home"
if (( start )); then "$deploy_home/dsh-enterprise" start; fi
