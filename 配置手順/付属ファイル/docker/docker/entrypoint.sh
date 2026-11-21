#!/bin/sh
# Container entrypoint.
# Started as root (the default): make the data volume writable for the unprivileged
# user "node" (uid 1000), then drop root for good and start the app as "node".
# Started as some other user (compose "user:"): just start the app.
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data 2>/dev/null \
    || echo "entrypoint: WARNING: could not change the owner of /app/data" >&2
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# Chromium needs a writable HOME for its crash-report and cache folders.
[ -w "${HOME:-/nonexistent}" ] || export HOME=/tmp
exec "$@"
