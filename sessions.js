var Sequelize = require("sequelize");
var model = require("./model.js");
var cookies = require("./cookies.js");

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
