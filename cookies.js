var config = require("./config.json");

// Shared attributes for cookies that carry authority.
//
// httpOnly keeps the value out of reach of page scripts, so a stored XSS
// can't exfiltrate a TA's session.  sameSite keeps the cookie off cross-site
// requests.  secure is set whenever we're actually served over HTTPS -- it's
// derived from config.protocol so that a plain-http dev instance still works.
//
// Note that we deliberately leave the path at its default ("/"), which is
// what these cookies have always used; changing it would orphan the cookies
// already sitting in people's browsers.
function secure_options(extra) {
    var opts = {
        httpOnly: true,
        sameSite: "lax",
        secure: config.protocol == "https"
    };
    Object.keys(extra || {}).forEach(function(key) {
        opts[key] = extra[key];
    });
    return opts;
}

// How long a session is good for.  The cookie and the database row use the
// same lifetime, so a stolen key stops working when the cookie would have
// expired rather than lasting forever.
exports.AUTH_MAX_AGE_MS = 30*24*60*60*1000;

// The session cookie.
exports.auth = function() {
    return secure_options({maxAge: exports.AUTH_MAX_AGE_MS});
};

// Same attributes, minus the lifetime, for res.clearCookie.
exports.auth_clear = function() {
    return secure_options();
};

// The OAuth state nonce.  Short-lived: it only has to survive the round trip
// out to Google and back.
exports.oauth_state = function() {
    return secure_options({maxAge: 10*60*1000});
};

// The CSRF cookie.  It's httpOnly like the others: the token reaches forms
// through the template, so no page script ever needs to read it back.
exports.csrf = function() {
    return secure_options({maxAge: exports.AUTH_MAX_AGE_MS});
};
