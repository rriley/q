// Verifies that moving socket authentication from a client-sent "authenticate"
// event to the handshake Cookie header still puts TAs in the TA room (they get
// the full entry payload) and leaves anonymous clients in the student room
// (they get only the redacted one).
const io = require("socket.io-client");
const http = require("http");

const env = require("./env.js");
const BASE = env.BASE;
const TA_KEY = env.TA_KEY;

function connect(label, cookie) {
    return new Promise((resolve, reject) => {
        const opts = { path: "/socket.io", transports: ["polling"], forceNew: true };
        if (cookie) opts.extraHeaders = { Cookie: cookie };
        const sock = io(BASE, opts);
        const received = [];
        sock.on("add", (m) => received.push(m));
        sock.on("connect", () => resolve({ label, sock, received }));
        sock.on("connect_error", reject);
        setTimeout(() => reject(new Error(label + " never connected")), 8000);
    });
}

// Fetch the queue page to pick up a CSRF cookie and its matching token,
// the way a browser would before submitting the form.
function getForm() {
    return new Promise((resolve, reject) => {
        http.get(BASE + "/", (res) => {
            let html = "";
            res.on("data", (c) => (html += c));
            res.on("end", () => resolve({
                cookie: (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; "),
                token: (html.match(/name="_csrf" value="([a-f0-9]{64})"/) || [])[1],
            }));
        }).on("error", reject);
    });
}

function post(body, form) {
    return new Promise((resolve, reject) => {
        const data = new URLSearchParams(Object.assign({_csrf: form.token}, body)).toString();
        const req = http.request(BASE + "/?json=1", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(data),
                "Cookie": form.cookie,
            },
        }, (res) => {
            let out = "";
            res.on("data", (c) => (out += c));
            res.on("end", () => {
                if (/Error/.test(out)) reject(new Error("post rejected: " + out));
                else resolve();
            });
        });
        req.on("error", reject);
        req.end(data);
    });
}

(async () => {
    const ta = await connect("TA", "auth=" + encodeURIComponent(TA_KEY));
    const anon = await connect("anonymous", null);
    // Give the server a moment to finish the async session lookup and room move.
    await new Promise((r) => setTimeout(r, 1200));

    const uid = "sock" + Math.floor(Math.random() * 10000);
    const form = await getForm();
    await post({
        action: "ADD", name: "Socket Test Student", user_id: uid,
        topic_id: "0", question: "does the socket still work",
    }, form);
    await new Promise((r) => setTimeout(r, 1500));

    let failures = 0;
    function assert(cond, msg) {
        console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
        if (!cond) failures++;
    }

    console.log("TA socket received:  ", JSON.stringify(ta.received[0]));
    console.log("anon socket received:", JSON.stringify(anon.received[0]));
    console.log("");

    assert(ta.received.length === 1, "TA socket got the add event");
    assert(anon.received.length === 1, "anonymous socket got the add event");
    assert(ta.received[0] && ta.received[0].data && ta.received[0].data.name === "Socket Test Student",
        "TA is in the TA room (received the full payload with the student name)");
    assert(anon.received[0] && anon.received[0].data === undefined,
        "anonymous client is in the student room (no name/user_id/question leaked)");

    ta.sock.close();
    anon.sock.close();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
