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

// The session cookie, good for 30 days.
exports.auth = function() {
    return secure_options({maxAge: 30*24*60*60*1000});
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
