#!/bin/bash
# End-to-end HTTP checks for the security fixes.  Expects an instance with a
# current semester set and a seeded TA session; test/run.sh provides both.
B=${QUEUE_TEST_URL:-http://127.0.0.1:${QUEUE_TEST_PORT:-15122}}
TA_KEY=${QUEUE_TEST_TA_KEY:-TESTTAKEY123}
DB=${QUEUE_TEST_DB:-queue-test-db}
DB_PW=${QUEUE_TEST_DB_PASSWORD:-roottest}
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
fails=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fails=$((fails+1)); }
want() { if echo "$2" | grep -q "$1"; then ok "$3"; else bad "$3 (got: $(echo "$2" | head -c 90))"; fi; }
nowant(){ if echo "$2" | grep -q "$1"; then bad "$3 (got: $(echo "$2" | head -c 90))"; else ok "$3"; fi; }
wantF(){ if echo "$2" | grep -qF "$1"; then ok "$3"; else bad "$3"; fi; }
nowantF(){ if echo "$2" | grep -qF "$1"; then bad "$3"; else ok "$3"; fi; }

docker exec "$DB" mysql -u root -p"$DB_PW" queue -e "UPDATE tas SET helping_id=NULL; DELETE FROM entries;" 2>/dev/null
rm -f $D/f_stu.jar $D/f_ta.jar

echo "-- CSRF --"
want "session expired" "$(curl -s -X POST "$B/?json=1" -d "action=ADD&name=F&user_id=forge01&topic_id=0&question=should be blocked")" "POST with no token is rejected"
TOK=$(curl -s -c $D/f_stu.jar "$B/" | grep -o 'value="[a-f0-9]\{64\}"' | head -1 | grep -o '[a-f0-9]\{64\}')
want "session expired" "$(curl -s -b $D/f_stu.jar -X POST "$B/?json=1" -d "_csrf=$(printf 'a%.0s' $(seq 1 64))&action=ADD&name=F&user_id=forge02&topic_id=0&question=should be blocked")" "POST with a mismatched token is rejected"
want "Entered the queue" "$(curl -s -b $D/f_stu.jar -X POST "$B/?json=1" --data-urlencode "_csrf=$TOK" -d "action=ADD&name=Flow Student&user_id=flow001&topic_id=0&question=a legitimate question")" "POST with the real token succeeds"

TATOK=$(curl -s -c $D/f_ta.jar -b "auth=$TA_KEY" "$B/settings" | grep -o 'value="[a-f0-9]\{64\}"' | head -1 | grep -o '[a-f0-9]\{64\}')
want "session expired" "$(curl -s -b $D/f_ta.jar -b "auth=$TA_KEY" -X POST "$B/options?json=1" -d "frozen=1")" "/options rejects a tokenless POST"
want "Queue frozen" "$(curl -s -b $D/f_ta.jar -b "auth=$TA_KEY" -X POST "$B/options?json=1" --data-urlencode "_csrf=$TATOK" -d "frozen=1")" "/options accepts a valid POST"
nowant "_csrf" "$(curl -s -b $D/f_ta.jar -b "auth=$TA_KEY" -X POST "$B/options?json=1" --data-urlencode "_csrf=$TATOK" -d "frozen=0")" "/options does not treat _csrf as an option"

echo "-- input validation --"
want "Invalid Name" "$(curl -s -b $D/f_stu.jar -X POST "$B/?json=1" --data-urlencode "_csrf=$TOK" --data-urlencode "name=$(printf 'a%.0s' $(seq 1 65))" -d "action=ADD&user_id=len001&topic_id=0&question=a valid question")" "65-char name rejected"
want "Invalid Question" "$(curl -s -b $D/f_stu.jar -X POST "$B/?json=1" --data-urlencode "_csrf=$TOK" --data-urlencode "question=$(printf 'z%.0s' $(seq 1 256))" -d "action=ADD&name=N&user_id=len002&topic_id=0")" "256-char question rejected"
want "Invalid Andrew ID" "$(curl -s -b $D/f_stu.jar -X POST "$B/?json=1" --data-urlencode "_csrf=$TOK" -d "action=ADD&name=N&topic_id=0&question=a valid question")" "missing user_id rejected cleanly"

echo "-- open redirect --"
want "^${B}/$" "$(curl -s -o /dev/null -w '%{redirect_url}' -b $D/f_ta.jar -b "auth=$TA_KEY" -H "Referer: https://evil.com/x" -X POST "$B/options" --data-urlencode "_csrf=$TATOK" -d "frozen=0")" "off-site Referer is not followed"
want "/settings" "$(curl -s -o /dev/null -w '%{redirect_url}' -b $D/f_ta.jar -b "auth=$TA_KEY" -H "Referer: ${B}/settings" -X POST "$B/options" --data-urlencode "_csrf=$TATOK" -d "frozen=0")" "same-host Referer is preserved"

echo "-- video chat url --"
want "must be a http" "$(curl -s -b $D/f_ta.jar -b "auth=$TA_KEY" -X POST "$B/settings?json=1" --data-urlencode "_csrf=$TATOK" --data-urlencode "video_chat_url=javascript:alert(1)" -d "action=UPDATEURL")" "javascript: URL rejected"
want "updated" "$(curl -s -b $D/f_ta.jar -b "auth=$TA_KEY" -X POST "$B/settings?json=1" --data-urlencode "_csrf=$TATOK" --data-urlencode "video_chat_url=https://cmu.zoom.us/j/1" -d "action=UPDATEURL")" "https URL accepted"

echo "-- authorization --"
want "403" "$(curl -s -o /dev/null -w '%{http_code}' "$B/metrics/counts.json?granularity=day")" "counts.json blocks anonymous"
want "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "auth=$TA_KEY" "$B/metrics/counts.json?granularity=day")" "counts.json allows a TA"

echo "-- XSS containment (server side) --"
curl -s -b $D/f_stu.jar -X POST "$B/?json=1" --data-urlencode "_csrf=$TOK" --data-urlencode 'name=</script><img src=x onerror=alert(1)>' -d "action=ADD&user_id=xss001&topic_id=0&question=payload check" >/dev/null
PAGE=$(curl -s -b "auth=$TA_KEY" "$B/")
nowantF '</script><img' "$PAGE" "payload does not break out of the script block"
wantF '<\/script>' "$PAGE" "payload is escaped inside the JSON blob"

echo
if [ $fails -eq 0 ]; then echo "All checks passed."; else echo "$fails FAILURES"; fi
exit $fails
