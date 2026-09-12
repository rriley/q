// TA access is resolved from the roster on every request, not from the ta_id
// stored on the session row.
//
// That column is written once, during the OAuth callback, from the TA list as
// it stood at that moment.  Anyone added to the roster after they had already
// signed in kept a null ta_id and stayed a plain student -- no Help button,
// and the queue rendered the way an anonymous student sees it -- until they
// logged out and back in.  The same applied after a semester rollover.
//
// Both the HTTP middleware and the socket handshake have to agree about this.
// The page picks its entry builder from what the render saw, so a TA the
// render trusts but the socket does not is sent the student payload and fails
// to draw live entries at all.
const io = require("socket.io-client");
const http = require("http");
const { execFileSync } = require("child_process");

const env = require("./env.js");
const BASE = env.BASE;

const DB = process.env.QUEUE_TEST_DB;
const DB_PW = process.env.QUEUE_TEST_DB_PASSWORD;
if (!DB || !DB_PW) {
    console.log("  SKIPPED  needs the throwaway database from test/run.sh");
    process.exit(0);
}

function sql(query) {
    return execFileSync("docker",
        ["exec", DB, "mysql", "-u", "root", "-p" + DB_PW, "queue", "-N", "-B", "-e", query],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Distinct from the fixture run.sh seeds, so tearing this down can't disturb
// the suites that run after it.
const EMAIL = "roster@andrew.cmu.edu";
const KEY = "ROSTERKEY" + Math.floor(Math.random() * 100000);
const OWNER_KEY = "OWNERKEY" + Math.floor(Math.random() * 100000);
// Matches owner_email in the config test/run.sh writes.
const OWNER_EMAIL = "owner@example.com";
const SEMESTER = sql("SELECT value FROM options WHERE `key`='current_semester';");

function get(path, cookie) {
    return new Promise((resolve, reject) => {
        http.get(BASE + path, { headers: cookie ? { Cookie: cookie } : {} }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on("error", reject);
    });
}

function post(body, cookie, form) {
    return new Promise((resolve, reject) => {
        const data = new URLSearchParams(Object.assign({ _csrf: form.token }, body)).toString();
        const req = http.request(BASE + "/?json=1", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(data),
                "Cookie": [cookie, form.cookie].filter(Boolean).join("; "),
            },
        }, (res) => {
            let out = "";
            res.on("data", (c) => (out += c));
            res.on("end", () => resolve({ body: out, headers: res.headers }));
        });
        req.on("error", reject);
        req.end(data);
    });
}

async function form(cookie) {
    const res = await get("/", cookie);
    return {
        cookie: (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; "),
        token: (res.body.match(/name="_csrf" value="([a-f0-9]{64})"/) || [])[1],
    };
}

// What home.ejs hands to client.js; null here means no Help button.
function renderedTaId(html) {
    const m = html.match(/^var ta_id = (.+);$/m);
    return m ? m[1] : "(absent)";
}

function connect(cookie) {
    return new Promise((resolve, reject) => {
        const opts = { path: "/socket.io", transports: ["polling"], forceNew: true };
        if (cookie) opts.extraHeaders = { Cookie: cookie };
        const sock = io(BASE, opts);
        const received = [];
        sock.on("add", (m) => received.push(m));
        sock.on("connect", () => resolve({ sock, received }));
        sock.on("connect_error", reject);
        setTimeout(() => reject(new Error("socket never connected")), 8000);
    });
}

function cleanup() {
    try {
        // The owner's roster row is created by the app itself, so it has to be
        // cleared too or it follows this suite into the next one.
        sql(`UPDATE tas SET helping_id=NULL WHERE email IN ('${EMAIL}','${OWNER_EMAIL}');
             DELETE FROM sessions WHERE session_key IN ('${KEY}','${OWNER_KEY}');
             DELETE FROM tas WHERE email IN ('${EMAIL}','${OWNER_EMAIL}');`);
    } catch (e) { /* teardown is best effort */ }
}

(async () => {
    const r = env.reporter();

    // Signed in first, added to the roster afterwards: exactly the ordering
    // that used to leave a TA stranded as a student.
    sql(`INSERT INTO sessions (name,email,user_id,session_key,authenticated,owner,ta_id,created_at,updated_at)
           VALUES ('Roster TA','${EMAIL}','roster','${KEY}',1,0,NULL,NOW(),NOW());
         INSERT INTO tas (email,full_name,semester,time_helped,num_helped,time_today,num_today,admin,created_at,updated_at)
           VALUES ('${EMAIL}','Roster TA','${SEMESTER}',0,0,0,0,1,NOW(),NOW());`);

    const stored = sql(`SELECT IFNULL(ta_id,'NULL') FROM sessions WHERE session_key='${KEY}';`);
    r.ok(stored === "NULL", "the session row's stored ta_id is still NULL (the state being tested)");

    let page = await get("/", "auth=" + KEY);
    r.ok(/^\d+$/.test(renderedTaId(page.body)),
        "a TA added to the roster after signing in is a TA on the next request "
        + "(rendered ta_id: " + renderedTaId(page.body) + ")");
    r.ok(/buildTAEntry|#add_form/.test(page.body), "and gets the TA view of the queue");

    // The socket handshake has to reach the same verdict as the render.
    const ta = await connect("auth=" + encodeURIComponent(KEY));
    const anon = await connect(null);
    await new Promise((res) => setTimeout(res, 1200));

    const uid = "ros" + Math.floor(Math.random() * 10000);
    const anonForm = await form(null);
    await post({ action: "ADD", name: "Roster Test Student", user_id: uid,
                 topic_id: "0", question: "does the roster ta see me" }, null, anonForm);
    await new Promise((res) => setTimeout(res, 1500));

    r.ok(ta.received[0] && ta.received[0].data && ta.received[0].data.name === "Roster Test Student",
        "the same TA lands in the TA room over the socket (full live payload)");
    r.ok(anon.received[0] && anon.received[0].data === undefined,
        "anonymous clients still get only the redacted payload");
    ta.sock.close();
    anon.sock.close();

    // Taken off the roster: access goes away on the next request rather than
    // lingering until the session's 30-day cookie runs out.
    sql(`DELETE FROM tas WHERE email='${EMAIL}';`);
    page = await get("/", "auth=" + KEY);
    r.ok(renderedTaId(page.body) === "null",
        "removing a TA from the roster revokes access immediately");

    // The owner is an admin without necessarily being on the roster, and the
    // page offers them "Add a student to the queue" either way.
    sql(`DELETE FROM tas WHERE email='${OWNER_EMAIL}';
         INSERT INTO sessions (name,email,user_id,session_key,authenticated,owner,ta_id,created_at,updated_at)
           VALUES ('The Owner','${OWNER_EMAIL}','owner','${OWNER_KEY}',1,1,NULL,NOW(),NOW());`);
    const ownerCookie = "auth=" + OWNER_KEY;

    // The owner holds every TA power, and HELP/DONE/REQUEST-UPDATE all need a
    // roster row to write to, so the app makes one on first sight.
    page = await get("/", ownerCookie);
    const ownerRoster = sql(`SELECT COUNT(*) FROM tas WHERE email='${OWNER_EMAIL}' AND semester='${SEMESTER}';`);
    r.ok(ownerRoster === "1", "the owner is given a roster row for the current semester");
    r.ok(/^\d+$/.test(renderedTaId(page.body)),
        "and reads as a TA on the page (rendered ta_id: " + renderedTaId(page.body) + ")");

    const ownerForm = await form(ownerCookie);
    const uid2 = "own" + Math.floor(Math.random() * 10000);
    const added = await post({ action: "ADD", name: "Owner Added Student", user_id: uid2,
                               topic_id: "0", question: "entered by the owner" },
                             ownerCookie, ownerForm);
    r.ok(!/Error/.test(added.body), "the owner can add a student (got: " + added.body.trim() + ")");
    const reissued = (added.headers["set-cookie"] || []).some((c) => /^auth=/.test(c));
    r.ok(!reissued, "and is not signed out by doing so (no replacement auth cookie)");

    // The three actions the owner used to be refused outright.
    const entryId = sql(`SELECT id FROM entries WHERE user_id='${uid2}';`);
    const f2 = await form(ownerCookie);
    const asked = await post({ action: "REQUEST-UPDATE", entry_id: entryId }, ownerCookie, f2);
    r.ok(!/Error/.test(asked.body), "the owner can ask a student to update their question");
    const helped = await post({ action: "HELP", entry_id: entryId }, ownerCookie, f2);
    r.ok(!/Error/.test(helped.body), "the owner can help a student (got: " + helped.body.trim() + ")");
    r.ok(sql(`SELECT status FROM entries WHERE id=${entryId};`) === "1",
        "and the entry is marked as being helped");
    const finished = await post({ action: "DONE", entry_id: entryId }, ownerCookie, f2);
    r.ok(/helped for/.test(finished.body),
        "the owner can finish helping (got: " + finished.body.trim() + ")");
    r.ok(sql(`SELECT num_helped FROM tas WHERE email='${OWNER_EMAIL}';`) === "1",
        "and the help is credited to the owner's roster row");

    // Nobody else gets a row invented for them.
    const strays = sql(`SELECT COUNT(*) FROM tas WHERE email='${EMAIL}';`);
    r.ok(strays === "0", "a non-owner is never auto-added to the roster");

    cleanup();
    r.done();
})().catch((e) => { cleanup(); console.error("ERROR:", e.message); process.exit(1); });
