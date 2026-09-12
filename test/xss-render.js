// Loads the real client.js entry-builders into a DOM and feeds them the
// payloads an attacker controls, asserting nothing executable is created.
const fs = require("fs");
const { JSDOM } = require("jsdom");

const env = require("./env.js");
const CLIENT = process.env.CLIENT || require("path").join(env.REPO, "static/js/client.js");
const src = fs.readFileSync(CLIENT, "utf8");

// Pinned to the same jQuery views/head.ejs loads from the CDN, so the
// escaping is exercised against the version that actually runs in
// production. Keep the devDependency and that <script> tag in step.
const jquerySrc = fs.readFileSync(require.resolve("jquery"), "utf8");
const dom = new JSDOM(
    `<!doctype html><html><head><script>${jquerySrc}</script></head>` +
    `<body><ul id="queue"></ul></body></html>`,
    { runScripts: "dangerously" }
);
const { window } = dom;
const $ = window.jQuery;
if (!$) throw new Error("jQuery failed to load into the jsdom window");

// Pull out just the constants and the three builders; the rest of client.js
// wires up socket.io and Materialize, which we don't have here.
const consts = src.slice(0, src.indexOf("var mq;"));
function grab(name) {
    const start = src.indexOf("function " + name + "(");
    let i = src.indexOf("{", start), depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
    }
}

const sandbox = { $, ta_id: 7, ta_helping_id: null, is_owner: false, window,
    csrf_token: "0".repeat(64) };
const body = consts + grab("buildTAEntry") + grab("buildMyEntry") + grab("buildStudentEntry") +
    "\nreturn {buildTAEntry, buildMyEntry, buildStudentEntry};";
const build = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));

const PAYLOADS = [
    `</script><img src=x onerror=alert(1)>`,
    `<img src=x onerror=alert(1)>`,
    `<script>alert(1)</script>`,
    `<svg onload=alert(1)>`,
    `"><img src=x onerror=alert(1)>`,
    `<iframe src="javascript:alert(1)"></iframe>`,
];

let failures = 0;
function check(label, elt, payload) {
    const html = $("<div>").append(elt).html();
    // Did any real element get created from the payload?
    const injected = $(elt).find("img, script, svg, iframe").length;
    // Does the payload survive as visible *text* (the desired outcome)?
    const asText = $(elt).text().includes(payload);
    const ok = injected === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(18)} injected=${injected} preserved-as-text=${asText}`);
    if (!ok) console.log("        " + html.slice(0, 160));
}

console.log("Feeding attacker-controlled fields through the real builders:\n");

for (const payload of PAYLOADS) {
    console.log(`payload: ${payload}`);
    check("TA view / name", build.buildTAEntry({
        id: 1, status: 0, name: payload, user_id: "evilstu", ta_id: null,
        topic_name: "other", ta_full_name: "", question: "q", cooldown_override: false,
        update_requested: false
    }), payload);
    check("TA view / question", build.buildTAEntry({
        id: 1, status: 0, name: "n", user_id: "evilstu", ta_id: null,
        topic_name: "other", ta_full_name: "", question: payload, cooldown_override: false,
        update_requested: false
    }), payload);
    check("TA view / topic", build.buildTAEntry({
        id: 1, status: 0, name: "n", user_id: "evilstu", ta_id: null,
        topic_name: payload, ta_full_name: "", question: "q", cooldown_override: false,
        update_requested: false
    }), payload);
    check("TA view / ta_name", build.buildTAEntry({
        id: 1, status: 1, name: "n", user_id: "evilstu", ta_id: 99,
        topic_name: "other", ta_full_name: payload, question: "q", cooldown_override: false,
        update_requested: false
    }), payload);
    check("own view / name", build.buildMyEntry({
        id: 1, status: 0, name: payload, user_id: "evilstu",
        topic_name: "other", ta_full_name: "", question: "q", update_requested: false
    }), payload);
    console.log("");
}

// The "X" button is real markup that must still be appended alongside the
// escaped TA name, so confirm the fix didn't break it.
const helping = build.buildTAEntry({
    id: 1, status: 1, name: "n", user_id: "s", ta_id: 99, topic_name: "t",
    ta_full_name: "Real TA", question: "q", cooldown_override: false, update_requested: false
});
const hasCsrf = $(helping).find("input.csrf-input").val() === "0".repeat(64);
console.log(`  ${hasCsrf ? "PASS" : "FAIL"}  per-entry form carries the CSRF token`);
if (!hasCsrf) failures++;
const hasX = $(helping).find("button.x-button").length === 1;
const saysHelping = $(helping).find(".helping-text").text().includes("Real TA is helping");
console.log(`  ${hasX && saysHelping ? "PASS" : "FAIL"}  x-button still rendered (${hasX}) and text intact (${saysHelping})`);
if (!(hasX && saysHelping)) failures++;

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
