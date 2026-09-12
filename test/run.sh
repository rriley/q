#!/bin/bash
#
# Runs the security regression suites against a throwaway stack.
#
# Brings up a MySQL container and a copy of the app (so your own config.json
# and database are never touched), seeds a semester and a TA session, runs
# every suite, then tears it all down.
#
# Requires: docker, and a Chrome/Chromium for the two browser suites (they're
# skipped with a warning if none is found).
#
#   npm test                 run everything
#   npm test -- xss socket   run only suites whose name matches
#
set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)
DB=${QUEUE_TEST_DB:-queue-test-db}
DB_PW=${QUEUE_TEST_DB_PASSWORD:-roottest}
PORT=${QUEUE_TEST_PORT:-15122}
TA_KEY=${QUEUE_TEST_TA_KEY:-TESTTAKEY123}
BASE="http://127.0.0.1:${PORT}"
APP_DIR=$(mktemp -d)
APP_PID=""

export QUEUE_TEST_DB="$DB" QUEUE_TEST_DB_PASSWORD="$DB_PW" QUEUE_TEST_PORT="$PORT"
export QUEUE_TEST_TA_KEY="$TA_KEY" QUEUE_TEST_URL="$BASE" QUEUE_TEST_APP="$APP_DIR"

cleanup() {
    [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
    docker rm -f "$DB" >/dev/null 2>&1
    rm -rf "$APP_DIR"
}
trap cleanup EXIT

db() {
    local err
    err=$(docker exec "$DB" mysql -u root -p"$DB_PW" queue -e "$1" 2>&1 >/dev/null \
          | grep -v "Using a password on the command line")
    if [ -n "$err" ]; then
        echo "SQL failed: $err" >&2
        return 1
    fi
}

command -v docker >/dev/null || { echo "docker is required to run these tests"; exit 1; }

echo "==> starting MySQL"
docker rm -f "$DB" >/dev/null 2>&1
docker run -d --name "$DB" \
    -e MYSQL_DATABASE=queue -e MYSQL_USER=queue -e MYSQL_PASSWORD=queue \
    -e MYSQL_ROOT_PASSWORD="$DB_PW" -p 127.0.0.1:3306:3306 mysql:8.0 >/dev/null || exit 1
# mysqladmin ping answers during the image's init phase, before the real
# server restarts, so wait on a query the app user can actually run.
ready() { docker exec "$DB" mysql -u queue -pqueue queue -e "SELECT 1" >/dev/null 2>&1; }
for i in $(seq 1 120); do ready && break; sleep 1; done
ready || { echo "MySQL did not become ready"; docker logs "$DB" 2>&1 | tail -20; exit 1; }

echo "==> staging the app in $APP_DIR"
tar -C "$REPO" --exclude=.git --exclude=node_modules --exclude=config.json \
    --exclude=data --exclude=test -cf - . | tar -C "$APP_DIR" -xf -
ln -s "$REPO/node_modules" "$APP_DIR/node_modules"
cat > "$APP_DIR/config.json" <<EOF
{
    "title": "Queue Test", "protocol": "http", "domain": "127.0.0.1:${PORT}",
    "path": "", "timezone": "America/New_York", "server_port": ${PORT},
    "mysql_host": "127.0.0.1", "mysql_db": "queue",
    "mysql_user": "queue", "mysql_pass": "queue",
    "google_id": "test-id", "google_secret": "test-secret",
    "allowed_domain": "andrew.cmu.edu", "owner_email": "owner@example.com"
}
EOF

start_app() {
    # exec so $! is node's own pid and cleanup can actually kill it.
    ( cd "$APP_DIR" && exec node index.js > "$APP_DIR/server.log" 2>&1 ) &
    APP_PID=$!
    for i in $(seq 1 30); do
        curl -sf -o /dev/null "$BASE/" && return 0
        kill -0 "$APP_PID" 2>/dev/null || break
        sleep 1
    done
    echo "the app did not come up; log follows:"; cat "$APP_DIR/server.log"; return 1
}
stop_app() {
    [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
    APP_PID=""
}

echo "==> starting the app"
start_app || exit 1

echo "==> seeding a semester and a TA"
db "INSERT INTO options (\`key\`,\`value\`,created_at,updated_at)
      VALUES ('current_semester','F26',NOW(),NOW())
      ON DUPLICATE KEY UPDATE value='F26';"
# The semester is cached in-process, so restart to pick it up.
stop_app; start_app || exit 1
db "INSERT INTO tas (email,full_name,semester,time_helped,num_helped,time_today,num_today,admin,created_at,updated_at)
      VALUES ('ta@andrew.cmu.edu','Test TA','F26',0,0,0,0,1,NOW(),NOW());
    INSERT INTO sessions (name,email,user_id,session_key,authenticated,owner,ta_id,created_at,updated_at)
      VALUES ('Test TA','ta@andrew.cmu.edu','ta','${TA_KEY}',1,0,
              (SELECT id FROM tas WHERE email='ta@andrew.cmu.edu'),NOW(),NOW());" || exit 1

echo "==> verifying the fixture"
curl -sf -b "auth=${TA_KEY}" "$BASE/metrics/counts.json?granularity=day" >/dev/null \
    || { echo "the seeded TA session is not being accepted; aborting"; exit 1; }

HAVE_CHROME=$(node -e 'process.stdout.write(require("'"$REPO"'/test/env.js").chrome() || "")')
[ -z "$HAVE_CHROME" ] && echo "==> no Chrome found; browser suites will be skipped"

# name | command | requirement
SUITES=$(cat <<LIST
xss-render|node $REPO/test/xss-render.js|
oauth-domain|node $REPO/test/oauth-domain.js|
oauth-roundtrip|node $REPO/test/oauth-roundtrip.js|
date-roundtrip|node $REPO/test/date-roundtrip.js|
session-expiry|node $REPO/test/session-expiry.js|
http-flows|bash $REPO/test/http-flows.sh|
socket-rooms|node $REPO/test/socket-rooms.js|
ta-roster|node $REPO/test/ta-roster.js|
help-scope|node $REPO/test/help-scope.js|
browser-csp|node $REPO/test/browser-csp.js|chrome
browser-ui|node $REPO/test/browser-ui.js|chrome
LIST
)

pass=0; fail=0; skip=0; failed=""
while IFS='|' read -r name cmd needs; do
    [ -z "$name" ] && continue
    if [ "$#" -gt 0 ]; then
        match=no
        for want in "$@"; do
            case "$name" in *"$want"*) match=yes;; esac
        done
        [ "$match" = no ] && continue
    fi
    if [ "$needs" = "chrome" ] && [ -z "$HAVE_CHROME" ]; then
        echo "---- $name: SKIPPED (no Chrome)"; skip=$((skip+1)); continue
    fi
    echo "---- $name"
    db "UPDATE tas SET helping_id=NULL; DELETE FROM entries;"
    if $cmd; then pass=$((pass+1)); else fail=$((fail+1)); failed="$failed $name"; fi
    echo
done <<< "$SUITES"

echo "================================================"
echo "suites: $pass passed, $fail failed, $skip skipped"
[ -n "$failed" ] && echo "failed:$failed"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
