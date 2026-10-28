#!/bin/sh
# Dumps the database to backups/fld-YYYYMMDD-HHMM.dump in the project directory. Made for a
# nightly cron job (docs/OPERATIONS.md → Backups): it runs from any directory, needs nothing from
# .env on the host, and stops at the first failed step with "backup FAILED" and a non-zero exit.
set -eu

cd "$(dirname "$0")/.."
file="backups/fld-$(date +%Y%m%d-%H%M).dump"
trap 'status=$?; rm -f "$file.partial"; [ "$status" = 0 ] || echo "$(date "+%F %T") backup FAILED" >&2' EXIT

mkdir -p backups
# In single quotes, so the db container fills in POSTGRES_USER and POSTGRES_DB from its own
# environment, which Compose set from .env. The host shell, and cron, don't have them.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c -f /tmp/fld.dump'
docker compose cp db:/tmp/fld.dump "$file.partial"
docker compose exec -T db rm /tmp/fld.dump
mv "$file.partial" "$file"
echo "$(date '+%F %T') backup written: $file"
