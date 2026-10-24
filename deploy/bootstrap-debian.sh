#!/usr/bin/env bash
set -euo pipefail
# Run only on a dedicated Debian 13 host named papersign, as root:
#   APP_URL=https://papersign.example.com TRUSTED_PROXY=PROXY_IP ./bootstrap-debian.sh
test "$(id -u)" = 0
test "$(hostname)" = papersign
: "${APP_URL:?Set APP_URL to the https address people will use}"
: "${TRUSTED_PROXY:?Set TRUSTED_PROXY to the IP address of the reverse proxy}"
export APP_URL TRUSTED_PROXY
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils postgresql postgresql-contrib nftables
NODE_VERSION=24.15.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
mkdir -p /opt/node
if ! /opt/node/bin/node --version 2>/dev/null | grep -qx "v${NODE_VERSION}"; then
  install_dir=$(mktemp -d)
  trap 'rm -rf "$install_dir"' EXIT
  cd "$install_dir"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$NODE_ARCHIVE"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt
  grep " ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum --check --status
  tar -xf "$NODE_ARCHIVE" --strip-components=1 --no-same-owner -C /opt/node
fi
ln -sfn /opt/node/bin/node /usr/local/bin/node
ln -sfn /opt/node/bin/npm /usr/local/bin/npm
ln -sfn /opt/node/bin/npx /usr/local/bin/npx
id papersign >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/papersign --shell /usr/sbin/nologin papersign
install -d -m 0755 /opt/papersign/releases
install -d -o papersign -g papersign -m 0700 /var/lib/papersign/data /var/lib/papersign/backups
install -d -o root -g papersign -m 0750 /etc/papersign
systemctl enable --now postgresql
/opt/node/bin/node --input-type=module - <<'NODE'
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const env = '/etc/papersign/papersign.env';
if (!existsSync(env)) {
  const password = randomBytes(32).toString('hex');
  const group = Number(execFileSync('id', ['-g', 'papersign'], { encoding: 'utf8' }).trim());
  const sql = `CREATE ROLE papersign LOGIN PASSWORD '${password}'; CREATE DATABASE papersign OWNER papersign ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0;`;
  execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  writeFileSync(env, [
    `DATABASE_URL=postgres://papersign:${password}@127.0.0.1:5432/papersign`,
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    `APP_URL=${process.env.APP_URL}`,
    'HOST=0.0.0.0',
    'PORT=3176',
    `TRUSTED_PROXY=${process.env.TRUSTED_PROXY}`,
    'DATA_DIR=/var/lib/papersign/data',
    'REGISTRATION_ENABLED=true',
    'NODE_ENV=production',
    '',
  ].join('\n'), { mode: 0o640, flag: 'wx' });
  chmodSync(env, 0o640);
  chownSync(env, 0, group);
}
NODE
printf 'PaperSign system dependencies ready.\n'
