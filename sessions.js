var Sequelize = require("sequelize");
var model = require("./model.js");
var cookies = require("./cookies.js");
var options = require("./routes/options.js");

// Expired rows are cleared out on this cadence.  Every anonymous queue
// signup creates a session, so without this the table grows forever.
var SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function cutoff() {
    return new Date(Date.now() - cookies.AUTH_MAX_AGE_MS);
}

// A session row outlives its cookie unless we check: the cookie is dropped by
// the browser after 30 days, but the row would still authenticate anyone who
// kept a copy of the key.
exports.is_expired = function(session) {
    return !session || !session.createdAt || session.createdAt < cutoff();
};

// Attaches the TA record that goes with a session, as session.TA.
//
// This is resolved per request rather than read back through the ta_id stored
// on the session row.  That column is written once, at login, from the TA
// list as it stood at that moment -- so somebody added to the roster after
// they had already signed in kept a null ta_id and stayed a plain student
// (no Help button, entries rendered as an anonymous student would see them)
// until they logged out and back in.  The same went for a semester rollover,
// where the roster rows are recreated for the new semester and every existing
// session still pointed at the old one.
//
// Scoped to the current semester, which is what login.js used to do and what
// makes a rollover drop last semester's TAs back to student access.
exports.attach_ta = function(session) {
    // Anonymous queue signups have no email to match on, and they are the
    // bulk of the traffic, so don't spend a query on them.
    if (!session || !session.authenticated || !session.email) {
        return Promise.resolve(session);
    }
    return options.current_semester().then(function(semester) {
        if (!semester) {
            return null;
        }
        return model.TA.findOne({
            where: {email: session.email, semester: semester}
        }).then(function(ta) {
            if (ta || !session.owner) {
                return ta;
            }
            return provision_owner(session, semester);
        });
    }).then(function(ta) {
        session.TA = ta || null;
        return session;
    });
};

// The owner holds every TA power, including the three that record a help:
// HELP, DONE and REQUEST-UPDATE.  All of those write to a roster row -- the
// helping_id that marks who a TA is with, and the helped/today counters -- and
// entries.ta_id has to point at one for "so-and-so is helping" to render at
// all.  So rather than make the owner add themselves to the list by hand
// before they can take a student, give them a row the first time they show up
// in a semester.
//
// findOrCreate rather than create: attach_ta runs on every request, so two
// requests arriving together would otherwise both insert.  There is no unique
// index on (email, semester) to fall back on.
function provision_owner(session, semester) {
    return model.TA.findOrCreate({
        where: {email: session.email, semester: semester},
        defaults: {
            // Sessions created before the name was recorded at login have
            // none; the roster is editable, so the Andrew ID is a fine stand-in.
            full_name: session.name || session.user_id,
            admin: true,
            time_helped: 0,
            num_helped: 0,
            time_today: 0,
            num_today: 0
        }
    }).then(function(result) {
        if (result[1]) {
            console.log("Added the owner (" + session.email + ") to the "
                        + semester + " TA list");
        }
        return result[0];
    });
}

exports.sweep = function() {
    return model.Session.destroy({
        where: {createdAt: {[Sequelize.Op.lt]: cutoff()}}
    }).then(function(removed) {
        if (removed) {
            console.log("Removed " + removed + " expired session(s)");
        }
        return removed;
    }).catch(function(error) {
        console.error("ERROR: could not sweep expired sessions:", error.message);
        return 0;
    });
};

exports.init = function() {
    exports.sweep();
    var timer = setInterval(exports.sweep, SWEEP_INTERVAL_MS);
    if (timer.unref) {
        timer.unref();
    }
};
