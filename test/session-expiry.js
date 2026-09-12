// A session row used to outlive its cookie indefinitely: the browser would
// drop the cookie after 30 days but the key still authenticated forever.
const env = require("./env.js");
const { execFileSync } = require("child_process");

const APP = env.APP;
const config = require(APP + "/config.json");
process.env.TZ = config.timezone;
const model = require(APP + "/model.js");
const sessions = require(APP + "/sessions.js");
const r = env.reporter();

const DB = process.env.QUEUE_TEST_DB || "queue-test-db";
const DB_PW = process.env.QUEUE_TEST_DB_PASSWORD || "roottest";
function sql(q) {
    execFileSync("docker", ["exec", DB, "mysql", "-u", "root", "-p" + DB_PW, "queue", "-e", q],
                 { stdio: ["ignore", "ignore", "ignore"] });
}
function get(path, cookie) {
    return execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}",
                                 "-b", cookie, env.BASE + path], { encoding: "utf8" });
}

(async () => {
    await model.sql.sync();

    const old = await model.Session.create({
        name: "Expired TA", email: "ta@andrew.cmu.edu", user_id: "ta",
        session_key: "EXPIREDKEY1", authenticated: true, owner: false,
    });
    const ta = await model.TA.findOne({ where: { email: "ta@andrew.cmu.edu" } });
    await old.update({ ta_id: ta ? ta.id : null });

    // Still young: should authenticate.
    r.ok(get("/metrics/counts.json?granularity=day", "auth=EXPIREDKEY1") === "200",
         "a fresh session authenticates");
    r.ok(sessions.is_expired(await model.Session.findByPk(old.id)) === false,
         "is_expired() is false for a fresh row");

    // Backdate it past the cookie lifetime.
    sql(`UPDATE sessions SET created_at = NOW() - INTERVAL 60 DAY WHERE id = ${old.id}`);
    r.ok(sessions.is_expired(await model.Session.findByPk(old.id)) === true,
         "is_expired() is true once the row is older than the cookie lifetime");
    r.ok(get("/metrics/counts.json?granularity=day", "auth=EXPIREDKEY1") === "403",
         "an expired session no longer authenticates");

    // And the sweep removes it.
    const removed = await sessions.sweep();
    r.ok(removed >= 1, `sweep() deletes expired rows (removed ${removed})`);
    r.ok((await model.Session.findByPk(old.id)) === null, "the expired row is gone");
    const taSession = await model.Session.findOne({ where: { session_key: env.TA_KEY } });
    r.ok(taSession !== null, "the sweep leaves unexpired sessions alone");

    await model.sql.close();
    r.done();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
