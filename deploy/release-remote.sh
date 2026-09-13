#!/usr/bin/env bash
# Host half of deploy/release.sh. Runs on the production host from the uploaded release:
#
#   bash /opt/rakurs-releases/<sha>/deploy/release-remote.sh <sha> <stamp>
#
# A file rather than a heredoc on ssh's stdin: `docker compose exec` and `run` read stdin, and
# would swallow every command after them, ending the script early with status 0.
set -euo pipefail

SHA="$1"
STAMP="$2"
REMOTE_DIR=/opt/rakurs
RELEASES_DIR=/opt/rakurs-releases
BACKUP_DIR=/opt/rakurs-backups
KEEP_RELEASES=5
KEEP_BACKUPS=10

compose() { docker compose -f deploy/compose.yml --env-file deploy/.env "$@" </dev/null; }

mkdir -p "$BACKUP_DIR"
cd "$REMOTE_DIR"

BACKUP="$BACKUP_DIR/rakurs-$STAMP-${SHA:0:12}.dump"
compose exec -T postgres pg_dump -U rakurs -Fc rakurs > "$BACKUP"
test -s "$BACKUP"
echo "database backup: $BACKUP"
docker image inspect rakurs-api:latest >/dev/null 2>&1 && docker tag rakurs-api:latest rakurs-api:rollback

# Files main does not track are moved aside rather than deleted, as are the ones replaced.
rsync -a --delete --backup --backup-dir="$RELEASES_DIR/replaced-$STAMP" \
  --exclude=/deploy/.env --exclude=/.release.sha "$RELEASES_DIR/$SHA/" "$REMOTE_DIR/"

compose build api
compose run --rm --no-deps -T api npm run migrate
compose up -d --no-deps api

if ! curl --silent --fail --retry 30 --retry-all-errors --retry-delay 1 --max-time 3 \
  http://127.0.0.1:3000/api/health >/dev/null; then
  echo "API did not become healthy on $SHA; restarting the previous image." >&2
  if docker image inspect rakurs-api:rollback >/dev/null 2>&1; then
    docker tag rakurs-api:rollback rakurs-api:latest
    compose up -d --no-deps --force-recreate api
  fi
  echo "Migrations that ran stay applied; the backup is $BACKUP." >&2
  exit 1
fi

echo "$SHA" > "$REMOTE_DIR/.release.sha"
echo "api healthy on $SHA"

# Retention: the newest releases and backups only. The running release is always kept.
# Best effort: a pipeline that matches nothing must not fail a release that already succeeded.
{
  ls -1dt "$RELEASES_DIR"/*/ | grep -v -e "/$SHA/\$" -e '/replaced-' | tail -n +"$KEEP_RELEASES" | xargs -r rm -rf
  ls -1dt "$RELEASES_DIR"/replaced-*/ | tail -n +"$((KEEP_RELEASES + 1))" | xargs -r rm -rf
  ls -1t "$BACKUP_DIR"/rakurs-*.dump | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
} 2>/dev/null || true
