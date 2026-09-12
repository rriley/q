// The TA's meeting URL used to be broadcast to every connected client.
// It must now reach only the student actually being helped.
const io = require("socket.io-client");
const http = require("http");

const env = require("./env.js");
const BASE = env.BASE;
const TA_COOKIE = env.TA_COOKIE;
const SECRET_URL = "https://cmu.zoom.us/j/TA-PRIVATE-ROOM";

function request(method, path, { cookie, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? new URLSearchParams(body).toString() : null;
        const headers = {};
        if (cookie) headers.Cookie = cookie;
        if (data) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
            headers["Content-Length"] = Buffer.byteLength(data);
        }
        const req = http.request(BASE + path, { method, headers }, (res) => {
            let out = "";
            res.on("data", (c) => (out += c));
            res.on("end", () => resolve({ body: out, headers: res.headers }));
        });
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

const jarOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const tokenOf = (html) => (html.match(/name="_csrf" value="([a-f0-9]{64})"/) || [])[1];

function connect(cookie) {
    return new Promise((resolve, reject) => {
        const opts = { path: "/socket.io", transports: ["polling"], forceNew: true };
        if (cookie) opts.extraHeaders = { Cookie: cookie };
        const sock = io(BASE, opts);
        const got = [];
        sock.on("help", (m) => got.push(m));
        sock.on("connect", () => resolve({ sock, got }));
        sock.on("connect_error", reject);
        setTimeout(() => reject(new Error("no connect")), 8000);
    });
}

(async () => {
    // TA sets a private meeting URL, and clears whoever they're helping.
    let page = await request("GET", "/settings", { cookie: TA_COOKIE });
    let taJar = TA_COOKIE + "; " + jarOf(page);
    let taTok = tokenOf(page.body);
    await request("POST", "/settings?json=1", { cookie: taJar,
        body: { _csrf: taTok, action: "UPDATEURL", video_chat_url: SECRET_URL } });

    // A student joins the queue and keeps their session cookie.
    page = await request("GET", "/");
    let stuJar = jarOf(page);
    const stuTok = tokenOf(page.body);
    const uid = "vid" + Math.floor(Math.random() * 10000);
    const uname = "Video Student " + uid;  // unique, so the lookup below can't match a stale row
    const added = await request("POST", "/?json=1", { cookie: stuJar,
        body: { _csrf: stuTok, action: "ADD", name: uname, user_id: uid,
                topic_id: "0", question: "please help me with this" } });
    if (!/Entered the queue/.test(added.body)) throw new Error("signup failed: " + added.body);
    stuJar = [stuJar, jarOf(added)].filter(Boolean).join("; ");

    // A third party who is just watching the queue.
    page = await request("GET", "/");
    const bystanderJar = jarOf(page);

    const student = await connect(stuJar);
    const bystander = await connect(bystanderJar);
    const ta = await connect(taJar);
    await new Promise((r) => setTimeout(r, 1200));

    // Find the entry and have the TA help it.
    page = await request("GET", "/", { cookie: taJar });
    taJar = TA_COOKIE + "; " + (jarOf(page) || taJar.split("; ").slice(1).join("; "));
    taTok = tokenOf(page.body);
    const entryId = (page.body.match(new RegExp('"id":(\\d+),"status":0,"name":"' + uname + '"')) || [])[1];
    if (!entryId) throw new Error("could not find the entry in the TA's page");
    const helped = await request("POST", "/?json=1", { cookie: taJar,
        body: { _csrf: taTok, action: "HELP", entry_id: entryId } });
    if (/Error/.test(helped.body)) throw new Error("help failed: " + helped.body);
    await new Promise((r) => setTimeout(r, 1500));

    let failures = 0;
    const check = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };
    const urlSeenBy = (c) => c.got.length && c.got[0].data && c.got[0].data.ta_video_chat_url;

    console.log("student   :", JSON.stringify(student.got[0]));
    console.log("bystander :", JSON.stringify(bystander.got[0]));
    console.log("TA        :", JSON.stringify(ta.got[0]));
    console.log("");
    check(student.got.length === 1 && bystander.got.length === 1 && ta.got.length === 1,
        "every client still receives the help event");
    check(urlSeenBy(student) === SECRET_URL, "the student being helped receives the meeting URL");
    check(!urlSeenBy(bystander), "an uninvolved student does NOT receive it");
    check(!urlSeenBy(ta), "another TA does NOT receive it");
    check(bystander.got[0] && bystander.got[0].data.ta_full_name === "Test TA",
        "bystander still learns who is helping (UI intact)");

    [student, bystander, ta].forEach((c) => c.sock.close());
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
