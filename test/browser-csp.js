// Loads the app in a real Chrome so the CSP is actually enforced, and fails
// on any CSP violation, console error, or blocked request.
const puppeteer = require("puppeteer-core");

const env = require("./env.js");
const BASE = env.BASE;
const TA_KEY = env.TA_KEY;
let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };

async function visit(browser, path, { asTA } = {}) {
    const page = await browser.newPage();
    const problems = [];
    page.on("console", (m) => {
        const t = m.text();
        if (m.type() === "error" || /Content Security Policy|Refused to/i.test(t)) problems.push("console: " + t);
    });
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("requestfailed", (r) => {
        const err = (r.failure() || {}).errorText || "";
        // Ignore benign aborts; flag anything the CSP blocked.
        if (/blocked|csp/i.test(err)) problems.push(`blocked: ${r.url()} (${err})`);
    });
    // Catch violations the page itself reports.
    await page.evaluateOnNewDocument(() => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) =>
            window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`));
    });
    if (asTA) {
        await page.setCookie({ name: "auth", value: TA_KEY, domain: "127.0.0.1", path: "/" });
    }
    await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    const violations = await page.evaluate(() => window.__csp || []);
    return { page, problems: problems.concat(violations) };
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: env.chrome(),
        headless: "new",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    for (const [path, asTA] of [["/", false], ["/", true], ["/settings", true], ["/metrics", true], ["/history", true]]) {
        const label = `${path}${asTA ? " (as TA)" : " (anonymous)"}`;
        const { page, problems } = await visit(browser, path, { asTA });
        ok(problems.length === 0, `${label}: no CSP violations or console errors`);
        problems.slice(0, 4).forEach((p) => console.log("          " + p.slice(0, 150)));
        await page.close();
    }

    // The queue page is the one with real behaviour: libraries, the socket,
    // and the converted click handlers.
    const { page, problems } = await visit(browser, "/", { asTA: true });
    const state = await page.evaluate(() => ({
        jquery: typeof window.jQuery === "function",
        materialize: typeof window.M === "object",
        socketio: typeof window.io === "function",
        connected: !!(window.socket && window.socket.connected),
        csrfToken: typeof window.csrf_token === "string" && window.csrf_token.length === 64,
        entries: document.querySelectorAll("#queue li").length,
        inlineHandlers: document.querySelectorAll("[onclick]").length,
        freezeLinks: document.querySelectorAll(".submit-parent-form").length,
        hiddenCsrfFields: document.querySelectorAll('input[name="_csrf"]').length,
        logoutGetLinks: document.querySelectorAll('a[href$="/logout"]').length,
        logoutForms: document.querySelectorAll('form[action$="/logout"]').length,
    }));
    console.log("\n  page state:", JSON.stringify(state));
    ok(state.jquery, "jQuery loaded from the CDN under CSP");
    ok(state.materialize, "Materialize loaded from the CDN under CSP");
    ok(state.socketio, "socket.io client loaded");
    ok(state.connected, "websocket/polling connection established under connect-src");
    ok(state.csrfToken, "csrf_token available to client.js from the nonced inline block");
    ok(state.inlineHandlers === 0, "no inline onclick attributes remain");
    ok(state.hiddenCsrfFields > 0, "forms carry the hidden CSRF field");
    ok(state.logoutGetLinks === 0, "no plain GET logout links remain");
    ok(state.logoutForms > 0, "logout is a POST form");
    ok(problems.length === 0, "no violations on the interactive page");

    // Prove an injected inline script really is refused by the CSP.
    const blocked = await page.evaluate(() => {
        return new Promise((resolve) => {
            window.__pwned = false;
            document.addEventListener("securitypolicyviolation", () => resolve("refused"), { once: true });
            const s = document.createElement("script");
            s.textContent = "window.__pwned = true;";
            document.body.appendChild(s);
            setTimeout(() => resolve(window.__pwned ? "EXECUTED" : "refused"), 500);
        });
    });
    ok(blocked === "refused", `injected inline <script> without the nonce is refused (got: ${blocked})`);

    await page.close();
    await browser.close();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
