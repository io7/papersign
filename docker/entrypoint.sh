#!/bin/sh
# PaperSign container commands. Usage: papersign <command> [arguments]
set -eu
umask 0077
command=${1:-web}
[ "$#" -gt 0 ] && shift
case "$command" in
  web)
    exec node --max-old-space-size=768 dist-server/server/index.js "$@" ;;
  worker)
    exec node --max-old-space-size=512 dist-server/server/worker.js "$@" ;;
  migrate)
    exec node dist-server/server/migrate.js "$@" ;;
  monitor)
    exec node dist-server/server/monitor.js "$@" ;;
  bootstrap-admin)
    exec node dist-server/scripts/bootstrap-admin.js "$@" ;;
  healthcheck)
    exec node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3176) + '/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" ;;
  verify-evidence)
    exec node dist-server/scripts/verify-evidence.js "$@" ;;
  help|--help|-h)
    echo "Commands: web (default), worker, migrate, monitor, bootstrap-admin --email EMAIL, healthcheck, verify-evidence FILE" ;;
  *)
    exec "$command" "$@" ;;
esac
