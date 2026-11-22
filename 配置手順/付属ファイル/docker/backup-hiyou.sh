#!/bin/sh
# Nightly backup of the hiyou-keisan database. Run as root on the NAS / Linux host.
#   1. copy data/hiyou.db to a dated file
#   2. verify the copy with the SQLite engine inside the app image (no network, read-only mount)
#   3. copy export.log and the operation log (data/audit)
#   4. delete verified copies older than KEEP_DAYS days
# Exit code 0 = a verified copy was written. Anything else = no valid backup today.
APP_DIR="${APP_DIR:-/volume1/docker/hiyou-keisan}"
DEST="${DEST:-/volume1/backup/hiyou-keisan}"
IMAGE="${IMAGE:-hiyou-keisan:local}"
KEEP_DAYS="${KEEP_DAYS:-60}"
RETRY_WAIT="${RETRY_WAIT:-20}"
PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# Opens the copy, runs SQLite's integrity check and refuses a database without patients
# (an empty database is what the app creates when its file was lost).
CHECK='const fs=require("fs");require("sql.js")().then(S=>{const d=new S.Database(fs.readFileSync(process.argv[1]));const r=d.exec("PRAGMA integrity_check")[0].values[0][0];const n=d.exec("SELECT COUNT(*) FROM patients")[0].values[0][0];d.close();console.log("integrity="+r+" patients="+n);process.exitCode=(r==="ok"&&n>0)?0:1}).catch(e=>{console.error("verify error: "+String(e));process.exitCode=1})'

mkdir -p "$DEST" || exit 1
OUT="hiyou-$(date +%Y%m%d-%H%M%S).db"
try=1
while [ "$try" -le 3 ]; do
  if cp "$APP_DIR/data/hiyou.db" "$DEST/$OUT" \
     && docker run --rm --network none -v "$DEST:/backup:ro" --entrypoint node "$IMAGE" -e "$CHECK" "/backup/$OUT"; then
    if [ -f "$APP_DIR/data/export.log" ]; then cp "$APP_DIR/data/export.log" "$DEST/export.log"; fi
    # operation log (audit-YYYY-MM.jsonl, append-only): copy the month files; nothing is deleted here
    if [ -d "$APP_DIR/data/audit" ]; then mkdir -p "$DEST/audit" && cp -p "$APP_DIR/data/audit/"audit-*.jsonl "$DEST/audit/" 2>/dev/null || echo "backup: WARNING: could not copy the operation log" >&2; fi
    find "$DEST" -name 'hiyou-*.db' -mtime +"$KEEP_DAYS" -exec rm -f {} \;
    echo "backup OK: $DEST/$OUT"
    exit 0
  fi
  echo "backup: copy or verification failed (try $try of 3)" >&2
  rm -f "$DEST/$OUT"
  try=$((try + 1))
  sleep "$RETRY_WAIT"
done
echo "backup FAILED: no verified copy was written" >&2
exit 1
