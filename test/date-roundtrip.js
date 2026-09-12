// Dates are written by Sequelize and read back by mysql2. Both were upgraded
// across a major version, so confirm a Date survives the round trip intact --
// a silent shift here would corrupt wait times and every metric.
const env = require("./env.js");
const APP = env.APP;
process.chdir(APP);
const config = require(APP + "/config.json");
process.env.TZ = config.timezone;
const model = require(APP + "/model.js");

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };

(async () => {
    await model.sql.sync();
    const written = new Date();
    const created = await model.Entry.create({
        user_id: "dtrt01", name: "Date Round Trip", semester: "F26",
        entry_time: written, status: 0, question: "date check",
        cooldown_override: 0, update_requested: false,
    });
    // Force a real read rather than reusing the in-memory instance.
    const read = await model.Entry.findByPk(created.id);
    const drift = Math.abs(read.entry_time.getTime() - written.getTime());
    console.log("  wrote       :", written.toISOString());
    console.log("  read back   :", read.entry_time.toISOString());
    console.log("  drift       :", drift, "ms");
    ok(drift < 1000, "a Date survives the write/read round trip with no timezone shift");

    // Date arithmetic the app actually relies on (cooldown, wait estimates).
    const past = new Date(Date.now() - 3600 * 1000);
    const e2 = await model.Entry.create({
        user_id: "dtrt02", name: "Hour Ago", semester: "F26",
        entry_time: past, status: 0, question: "date check 2",
        cooldown_override: 0, update_requested: false,
    });
    const r2 = await model.Entry.findByPk(e2.id);
    const elapsedMin = (Date.now() - r2.entry_time.getTime()) / 60000;
    console.log("  elapsed for an entry written 60 min ago:", elapsedMin.toFixed(2), "min");
    ok(Math.abs(elapsedMin - 60) < 1, "elapsed-time arithmetic is correct across the round trip");

    await model.Entry.destroy({ where: { user_id: ["dtrt01", "dtrt02"] } });
    await model.sql.close();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
