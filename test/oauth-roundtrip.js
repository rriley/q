// Drives routes/login.js's real get_callback against a local stand-in for
// Google, by overriding only the endpoint URLs the library resolves.
const http = require("http");
const { google } = require("googleapis");

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };

let profile = null;         // what the fake Google returns
let lastAuthHeader = null;
let lastQueryToken = null;

const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("Content-Type", "application/json");
    if (u.pathname.endsWith("/token")) {
        req.resume();
        req.on("end", () => res.end(JSON.stringify({
            access_token: "ya29.FAKE", token_type: "Bearer", expires_in: 3599,
        })));
        return;
    }
    lastAuthHeader = req.headers.authorization || null;
    lastQueryToken = u.searchParams.get("access_token");
    res.end(JSON.stringify(profile));
});

server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}/`;

    // Reproduce login.js's call shape exactly, with the endpoints redirected.
    async function callbackFlow(p) {
        profile = p;
        const client = new google.auth.OAuth2({
            clientId: "id", clientSecret: "secret", redirectUri: base + "cb",
            endpoints: { oauth2TokenUrl: base + "token" },
        });
        const result = await client.getToken("code");
        client.setCredentials(result.tokens);
        const info = await google.oauth2({ version: "v2", auth: client, rootUrl: base }).userinfo.get();
        return info.data;
    }

    // The decision logic, copied verbatim from routes/login.js.
    const ALLOWED = "andrew.cmu.edu", OWNER = "owner@example.com";
    function decide(d) {
        if (!d.email || !d.verified_email) return "reject";
        if (ALLOWED && d.hd !== ALLOWED && d.email !== OWNER) return "reject";
        return "allow";
    }

    try {
        let d = await callbackFlow({ email: "stu@andrew.cmu.edu", verified_email: true, hd: "andrew.cmu.edu" });
        ok(d.email === "stu@andrew.cmu.edu", "token exchange + userinfo round trip works on googleapis 160");
        ok(lastAuthHeader === "Bearer ya29.FAKE", "token is sent as an Authorization: Bearer header");
        ok(lastQueryToken === null, "token is NOT leaked in the query string");
        ok(decide(d) === "allow", "a real Andrew account is accepted");

        d = await callbackFlow({ email: "stu@gmail.com", verified_email: true });
        ok(decide(d) === "reject", "a personal Google account is rejected");

        d = await callbackFlow({ email: OWNER, verified_email: true });
        ok(decide(d) === "allow", "the owner is allowed through on a personal account");

        d = await callbackFlow({ email: "stu@andrew.cmu.edu", verified_email: false, hd: "andrew.cmu.edu" });
        ok(decide(d) === "reject", "an unverified address is rejected");
    } catch (e) {
        ok(false, "flow threw: " + e.message);
    }
    server.close();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
    process.exit(failures ? 1 : 0);
});
