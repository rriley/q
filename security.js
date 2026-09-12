var crypto = require("crypto");
var helmet = require("helmet");
var config = require("./config.json");

var https = config.protocol == "https";

// A fresh nonce per response, so the templates' inline <script> blocks can be
// allowed by the CSP without opening the door to injected ones.
exports.nonce = function(req, res, next) {
    res.locals.csp_nonce = crypto.randomBytes(16).toString("base64");
    next();
};

exports.headers = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Inline blocks are allowed only by nonce.  Injected markup can't
            // guess it, so a stored XSS can't execute even if one slips past
            // the escaping in client.js.
            scriptSrc: [
                "'self'",
                function(req, res) { return "'nonce-" + res.locals.csp_nonce + "'"; },
                "https://ajax.googleapis.com",
                "https://cdnjs.cloudflare.com"
            ],
            // Materialize sets element styles at runtime and the templates
            // carry style="" attributes, so inline styles have to stay.  This
            // is a much smaller exposure than inline script.
            styleSrc: [
                "'self'", "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://cdnjs.cloudflare.com"
            ],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:"],
            // Same-origin XHR, plus the socket.io websocket named
            // explicitly: current browsers match ws:// against 'self', but
            // older ones don't, and a blocked socket degrades the whole
            // live-update experience silently.
            connectSrc: ["'self'", (https ? "wss://" : "ws://") + config.domain],
            formAction: ["'self'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            // Only meaningful over https, and actively breaks a plain-http
            // deployment by rewriting its own asset URLs.
            upgradeInsecureRequests: https ? [] : null
        }
    },
    // helmet's default is no-referrer, which would strip the Referer that
    // routes/options.js uses to send an admin back where they came from.
    // same-origin keeps that working without leaking the URL off-site.
    referrerPolicy: {policy: "same-origin"},
    // Pointless (and ignored) over plain http.
    strictTransportSecurity: https
        ? {maxAge: 15552000, includeSubDomains: true}
        : false
});
