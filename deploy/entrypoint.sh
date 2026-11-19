#!/bin/sh
# Start the app. With backups configured: first restore any database missing on this disk
# (a new server, or a lost disk), then run the app under Litestream so every change is backed up.
set -e
cd /app
APP="node server/index.js"

if node server/backup.js enabled; then
  umask 077 # the generated config holds the storage keys
  node server/backup.js config /tmp/litestream.json
  node server/backup.js restore
  echo "Backups on: every change is copied to storage within seconds."
  exec litestream replicate -config /tmp/litestream.json -exec "$APP"
fi

echo "WARNING: backups are OFF. Set BACKUP_S3_BUCKET (see deploy/README.md) before real data goes in." >&2
exec $APP
