// Drives the real UI in Chrome: the click handlers converted away from
// inline onclick attributes, and a full queue signup through the form.
const puppeteer = require("puppeteer-core");
const env = require("./env.js");
const BASE = env.BASE;
let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };

(async () => {
    const browser = await puppeteer.launch({
        executablePath: env.chrome(), headless: "new",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    // --- A student signs up through the actual form ---
    const stu = await browser.newPage();
    const errors = [];
    stu.on("pageerror", (e) => errors.push(e.message));
    stu.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await stu.goto(BASE + "/", { waitUntil: "networkidle2" });
    const uid = "br" + Math.floor(Math.random() * 100000);
    await stu.evaluate(() => { document.querySelector("#add_form").style.display = "block"; });
    await stu.type("#name", "Browser Student");
    await stu.type("#user_id", uid);
    await stu.type("#question", "does the whole form still work end to end");
    await stu.select("select.topic", "0").catch(() => {});
    await stu.evaluate(() => {
        const f = document.querySelector("#add_form form");
        const t = f.querySelector('select[name="topic_id"]');
        if (t) t.value = "0";
    });
    await Promise.all([
        stu.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
        stu.evaluate(() => submitAddForm(false)),
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    const mine = await stu.evaluate(() => {
        const me = document.querySelector("#queue li.me");
        return me ? me.querySelector(".entry-name").textContent : null;
    });
    ok(mine && mine.includes("Browser Student"), `signup through the form worked (entry: ${mine})`);
    ok(errors.length === 0, `no page errors during signup${errors.length ? ": " + errors[0].slice(0, 90) : ""}`);

    // --- A TA uses the converted click handlers ---
    const ta = await browser.newPage();
    // The converted freeze link only exists in the mobile sidenav; the
    // desktop nav uses a plain submit button that needs no JS.  Several
    // elements share .submit-parent-form now (freeze and both logout links),
    // so the clicks below target the freeze link inside the sidenav.
    await ta.setViewport({ width: 480, height: 900 });
    await ta.setCookie({ name: "auth", value: env.TA_KEY, domain: "127.0.0.1", path: "/" });
    await ta.goto(BASE + "/", { waitUntil: "networkidle2" });

    // "Add a message" / edit pencil -> reveals the message form.
    const beforeVisible = await ta.evaluate(() => document.querySelector("#message_form").offsetParent !== null);
    await ta.click(".edit-message");
    await new Promise((r) => setTimeout(r, 400));
    const afterVisible = await ta.evaluate(() => document.querySelector("#message_form").offsetParent !== null);
    ok(!beforeVisible && afterVisible, "converted .edit-message handler opens the message form");

    // Cancel closes it again.
    await ta.click(".cancel-edit-message");
    await new Promise((r) => setTimeout(r, 400));
    const afterCancel = await ta.evaluate(() => document.querySelector("#message_form").offsetParent !== null);
    ok(!afterCancel, "converted .cancel-edit-message handler closes it");

    // Freeze link submits its parent form (and must carry the CSRF token).
    const frozenBefore = await ta.evaluate(() => document.querySelector("#frozen_message").offsetParent !== null);
    const openSidenav = async () => {
        await ta.click(".sidenav-trigger");
        await new Promise((r) => setTimeout(r, 700));
    };
    await openSidenav();
    await Promise.all([
        ta.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
        ta.click("#nav-mobile .freeze-btn"),
    ]);
    await new Promise((r) => setTimeout(r, 800));
    const frozenAfter = await ta.evaluate(() => document.querySelector("#frozen_message").offsetParent !== null);
    ok(!frozenBefore && frozenAfter, "converted freeze link submits the form and the queue freezes");

    // Put it back.
    await openSidenav();
    await Promise.all([
        ta.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
        ta.click("#nav-mobile .freeze-btn"),
    ]);
    await new Promise((r) => setTimeout(r, 800));
    ok(!(await ta.evaluate(() => document.querySelector("#frozen_message").offsetParent !== null)),
       "and unfreezes again");

    await browser.close();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
