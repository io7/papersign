#!/usr/bin/env bash
set -euo pipefail
# Run as root inside the dedicated PaperSign CT with an uploaded release tarball.
test "$(id -u)" = 0
test "$(hostname)" = papersign
if systemctl is-active --quiet papersign-web || systemctl is-active --quiet papersign-worker; then
  printf 'Stop PaperSign web and worker after taking the approved consistent backup before installing.\n' >&2
  exit 1
fi
release_id=${1:?Usage: install-release.sh RELEASE_ID ARCHIVE}
archive=${2:?Missing release archive}
[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]]
release_dir="/opt/papersign/releases/$release_id"
test ! -e "$release_dir"
mkdir "$release_dir"
tar -xzf "$archive" -C "$release_dir" --no-same-owner
cd "$release_dir"
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm ci --omit=dev --no-fund --loglevel error
chown -R root:papersign "$release_dir"
chmod -R g+rX,o-rwx "$release_dir"
runuser -u papersign -- /opt/node/bin/node --env-file=/etc/papersign/papersign.env dist-server/server/migrate.js
install -m 0644 deploy/papersign-*.service deploy/papersign-*.timer /etc/systemd/system/
previous=''
if [[ -L /opt/papersign/current ]]; then
  previous=$(readlink -f /opt/papersign/current)
fi
ln -sfn "$release_dir" /opt/papersign/next
mv -Tf /opt/papersign/next /opt/papersign/current
systemctl daemon-reload
systemctl enable papersign-web papersign-worker papersign-backup.timer papersign-monitor.timer
if systemctl is-enabled --quiet papersign-sealer; then
  systemctl restart papersign-sealer
fi
systemctl restart papersign-web papersign-worker
systemctl start papersign-backup.timer papersign-backup.service papersign-monitor.timer
for attempt in {1..20}; do
  if curl --silent --fail http://127.0.0.1:3176/api/health >/dev/null; then
    printf 'PaperSign release %s healthy. Previous release: %s\n' "$release_id" "${previous:-none}"
    exit 0
  fi
  sleep 1
done
printf 'PaperSign failed health checks. Inspect service journals before cutover.\n' >&2
exit 1
