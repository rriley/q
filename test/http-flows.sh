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

echo "-- logout --"
rm -f $D/lo.jar
curl -s -c $D/lo.jar -b "auth=$TA_KEY" -o /dev/null "$B/settings"
LOTOK=$(curl -s -b $D/lo.jar -b "auth=$TA_KEY" "$B/settings" | grep -o 'value="[a-f0-9]\{64\}"' | head -1 | grep -o '[a-f0-9]\{64\}')
curl -s -b "auth=$TA_KEY" -o /dev/null "$B/logout"
want "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "auth=$TA_KEY" "$B/metrics/counts.json?granularity=day")" "GET /logout does not log the user out"
want "session expired" "$(curl -s -b $D/lo.jar -b "auth=$TA_KEY" -X POST "$B/logout?json=1")" "POST /logout without a token is rejected"
# A valid POST must actually log out -- on a throwaway session, so the shared
# TA fixture the later suites rely on stays intact.
rm -f $D/tmp.jar
TMPTOK=$(curl -s -c $D/tmp.jar "$B/" | grep -o 'value="[a-f0-9]\{64\}"' | head -1 | grep -o '[a-f0-9]\{64\}')
curl -s -b $D/tmp.jar -c $D/tmp.jar -X POST "$B/?json=1" --data-urlencode "_csrf=$TMPTOK" \
     -d "action=ADD&name=Logout Probe&user_id=lo0001&topic_id=0&question=probing logout" >/dev/null
BEFORE=$(docker exec "$DB" mysql -N -u root -p"$DB_PW" queue -e "SELECT COUNT(*) FROM sessions WHERE user_id='lo0001'" 2>/dev/null | tr -d '[:space:]')
curl -s -b $D/tmp.jar -X POST "$B/logout" --data-urlencode "_csrf=$TMPTOK" -o /dev/null
AFTER=$(docker exec "$DB" mysql -N -u root -p"$DB_PW" queue -e "SELECT COUNT(*) FROM sessions WHERE user_id='lo0001'" 2>/dev/null | tr -d '[:space:]')
want "^1$" "$BEFORE" "the probe session existed before logout"
want "^0$" "$AFTER" "POST /logout with a valid token destroys the session"

echo "-- subresource integrity --"
HEAD_HTML=$(curl -s "$B/")
want 'jquery/3.7.1' "$HEAD_HTML" "jQuery is past the 3.1.1 XSS advisories"
nowant 'jquery/3.1.1' "$HEAD_HTML" "the vulnerable jQuery is gone"
# Check every page, not just the queue: the chart and settings pages pull
# their own libraries (d3, c3, flatpickr).
for pg in "" settings metrics history; do
    PAGE=$(curl -s -b "auth=$TA_KEY" "$B/$pg")
    TAGS=$( { echo "$PAGE" | grep -o '<\(script\|link\)[^>]*cdnjs[^>]*>'; \
              echo "$PAGE" | grep -o '<script[^>]*ajax\.googleapis[^>]*>'; } | grep . )
    N=$(echo "$TAGS" | grep -c . )
    WITH=$(echo "$TAGS" | grep -c 'integrity="sha384-')
    if [ "$N" -eq 0 ]; then
        bad "/${pg:-(queue)} served no pinned CDN tags to check"
    else
        want "^${N}$" "$WITH" "/${pg:-(queue)}: all $N pinned CDN assets carry an SRI hash"
    fi
done

echo
if [ $fails -eq 0 ]; then echo "All checks passed."; else echo "$fails FAILURES"; fi
exit $fails
