#!/bin/sh
# Container entrypoint for the combined web+service image.
#
# Default boot (no command override, i.e. the image CMD): apply database
# migrations, then start the server. The migration runner is idempotent and
# baseline-safe — a no-op against an already-migrated database, and it
# auto-provisions a fresh self-host database, so `docker compose up` works with
# no manual SQL.
#
# Command override (e.g. deploy.yml's `node dist/preflight.js`): run THAT command
# directly, WITHOUT migrating. Preflight is a side-effect-free connectivity gate
# run before the container swap, so it must not mutate the database.
#
# `exec` replaces this shell with the target process so it becomes PID 1 and
# receives SIGTERM directly — enabling the service's graceful 15s drain on stop.
set -eu

# The image CMD is the default server start. When it is in effect (or the caller
# explicitly asks to start the server), run migrations first; otherwise pass the
# override through untouched.
if [ "$#" -eq 0 ] || { [ "$1" = "node" ] && [ "${2:-}" = "dist/index.js" ]; }; then
  echo "[entrypoint] Running database migrations..."
  node dist/db/migrate.js
  echo "[entrypoint] Starting service..."
  if [ "$#" -eq 0 ]; then
    exec node dist/index.js
  fi
  exec "$@"
fi

echo "[entrypoint] Running command: $*"
exec "$@"
