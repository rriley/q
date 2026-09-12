var crypto = require("crypto");
var config = require("./config.json");
var cookies = require("./cookies.js");

var COOKIE = "csrf";
var TOKEN_RE = /^[a-f0-9]{64}$/;
var SAFE_METHODS = {GET: true, HEAD: true, OPTIONS: true};

function new_token() {
    return crypto.randomBytes(32).toString("hex");
}

// Constant-time compare that tolerates junk input.
function matches(sent, expected) {
    if (typeof sent !== "string" || typeof expected !== "string") {
        return false;
    }
    var a = Buffer.from(sent);
    var b = Buffer.from(expected);
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

// Double-submit CSRF protection.
//
// Every visitor gets a high-entropy `csrf` cookie, and every form carries the
// same value in a hidden _csrf field.  A cross-site attacker can't read the
// cookie, so they can't populate the field; and because the cookie is
// SameSite=Lax it isn't even sent on a cross-site POST, so a forged request
// fails the comparison either way.
//
// The token is bound to the browser rather than to a login session on
// purpose: anonymous visitors post to the queue too, before any session
// exists.
exports.middleware = function(req, res, next) {
    var token = req.cookies[COOKIE];
    if (!token || !TOKEN_RE.test(token)) {
        token = new_token();
        res.cookie(COOKIE, token, cookies.csrf());
    }
    // res.locals reaches every template, so no render call has to pass it.
    res.locals.csrf_token = token;
    req.csrf_token = token;

    if (SAFE_METHODS[req.method]) {
        next();
        return;
    }

    var sent = (req.body && req.body._csrf) || req.get("X-CSRF-Token");
    if (matches(String(sent == null ? "" : sent), token)) {
        next();
        return;
    }

    console.log("ERROR: rejected " + req.method + " " + req.path + " (bad or missing CSRF token)");
    // Report it the way the rest of the app reports errors, so a user whose
    // cookie went stale sees a message and can just try again.
    var message = "Your session expired. Please reload the page and try again.";
    if (req.query.json) {
        res.json({message: "Error: " + message});
    } else {
        res.cookie("toast", message, {path: config.path});
        res.redirect(config.path + "/");
    }
};
