var crypto = require('crypto');
var google = require('googleapis').google;

var config = require("../config.json");
var model = require("../model.js");
var options = require("./options.js");
var cookies = require("../cookies.js");

var redirect_uri = config.protocol + "://" + config.domain + config.path + "/oauth2/callback";

// A fresh client per request.  get_callback sets credentials on it, and a
// module-level client would mean two simultaneous logins could overwrite each
// other's tokens.
function oauth_client() {
    return new google.auth.OAuth2(config.google_id, config.google_secret, redirect_uri);
}

// Which Google Workspace domain accounts have to belong to.  Set
// "allowed_domain" to "" (or null) in config.json to accept any Google
// account.  The owner is always allowed through, so an install whose
// owner_email is a personal address can still be set up.
var allowed_domain = config.allowed_domain === undefined
    ? "andrew.cmu.edu"
    : config.allowed_domain;

// An error whose message is safe to show the user.  Anything else that comes
// out of the OAuth flow is logged but reported generically.
function PublicError(message) {
    this.message = message;
}
PublicError.prototype = Object.create(Error.prototype);
PublicError.prototype.name = "PublicError";

function auth_url(state, domaincheck) {
    var params = {
        scope: ["profile", "email"],
        state: state
    };
    // Only a hint for the account chooser -- Google will still hand us
    // whatever account the user picks, so get_callback does the real check.
    if (domaincheck && allowed_domain) {
        params.hd = allowed_domain;
    }
    return oauth_client().generateAuthUrl(params);
}

exports.get_login = function(req, res) {
    if (req.session && req.session.authenticated) {
        res.redirect(config.path+"/");
        return;
    }
    // Bind this login attempt to the browser that started it, so nobody can
    // hand a victim a callback URL for an account the attacker controls.
    var state = crypto.randomBytes(32).toString("hex");
    res.cookie("oauth_state", state, cookies.oauth_state());
    res.redirect(auth_url(state, req.query.domaincheck != 0));
};

exports.get_callback = function(req, res) {
    var key = crypto.randomBytes(72).toString('base64');
    var expected_state = req.cookies.oauth_state;
    var email;

    res.clearCookie("oauth_state", cookies.auth_clear());

    function fail(error) {
        console.log("ERROR: oauth callback failed: " + ((error && error.stack) || error));
        if (res.headersSent) {
            return;
        }
        res.cookie("toast", error instanceof PublicError
            ? error.message
            : "Sign-in failed. Please try again.", {path: config.path});
        res.redirect(config.path + "/");
    }

    if (!expected_state || !req.query.state || req.query.state !== expected_state) {
        fail(new PublicError("Your sign-in attempt expired. Please try again."));
        return;
    }

    var client = oauth_client();
    client.getToken(req.query.code).then(function(result) {
        // Authenticate with an Authorization: Bearer header rather than an
        // ?access_token= query parameter, which Google deprecated and which
        // would put the token in every access log along the way.
        client.setCredentials(result.tokens);
        return google.oauth2({version: "v2", auth: client}).userinfo.get();
    }).then(function(userinfo) {
        var profile = userinfo.data;
        // Google only vouches for the address if it says it's verified.
        if (!profile.email || !profile.verified_email) {
            throw new PublicError("Your Google account's email address isn't verified.");
        }
        // Without this, any Google account whose local part matches an Andrew
        // ID would be treated as that student everywhere we compare user_id.
        if (allowed_domain
                && profile.hd !== allowed_domain
                && profile.email !== config.owner_email) {
            throw new PublicError("Please sign in with your " + allowed_domain + " account.");
        }
        email = profile.email;
        return Promise.all([options.current_semester(), model.sql.sync()]);
    }).then(function(results) {
        return model.TA.findOne({
            where: {
                email: email,
                semester: results[0]
            }
        });
    }).then(function(ta) {
        return model.Session.create({
            "email": email,
            "user_id": email.substring(0, email.indexOf("@")),
            "session_key": key,
            "authenticated": true,
            "ta_id": ta ? ta.id : null,
            "owner": email == config.owner_email
        });
    }).then(function() {
        res.cookie("auth", key, cookies.auth());
        res.redirect(config.path+"/");
    }).catch(fail);
};

exports.get_logout = function(req, res) {
    var destroyed = req.session ? req.session.destroy() : Promise.resolve();
    destroyed.catch(function(error) {
        console.log("ERROR: could not destroy session: " + error.message);
    }).then(function() {
        res.clearCookie("auth", cookies.auth_clear());
        res.redirect(config.path+"/");
    });
};
