var async = require('async');
var crypto = require('crypto');

var config = require("../config.json");
var model = require("../model.js");
var realtime = require("../realtime.js");
var waittimes = require("../waittimes.js");
var options = require("./options.js");

var entries_cache = null;
var topics_cache = null;
var topics_cache_updated = new Date(0);

exports.get = function(req, res) {
    // If we need to display a toast on this request, it'll be in a cookie.
    // Store the message and clear the cookie so the user only sees it once.
    var toast = null;
    if (req.cookies.toast) {
        toast = req.cookies.toast;
        res.clearCookie("toast");
    }
    var entries = [];
    var topics = [];
    var frozen = false;
    var message = "";

    Promise.resolve().then(function() {
        //don't re-query the database if nothing has changed
        if (entries_cache) {
            entries = entries_cache;
            return;
        }
        return model.Entry.findAll({
            where: {status: {lt: 2}},
            include: [{model: model.TA, as: "TA"},
                      {model: model.Topic}],
            order: [['entry_time', 'ASC']]
        }).then(function(results) {
            entries = results;
            entries_cache = results;
        });
    }).then(function() {
        //don't re-query the database if nothing has changed
        if (topics_cache && topics_cache_updated > new Date(new Date().getTime() + 1000*60*60)) {
            topics = topics_cache;
            return;
        }
        //our cache is out-of-date (or doesn't exist), query the database
        return model.Topic.findAll({
            where: {
                out_date: {lt: new Date()},
                due_date: {gt: new Date()}
            },
            order: [['due_date', 'ASC']]
        }).then(function(results) {
            topics = results;
            topics_cache = results;
            topics_cache_updated = new Date();
        });
    }).then(options.frozen).then(function(result) {
        frozen = result;
    }).then(options.message).then(function(result) {
        message = result;
    }).then(function() {
        res.render("home", {
            title: config.title,
            session: req.session,
            entries: entries,
            topics: topics,
            seq: realtime.seq,
            frozen: frozen,
            message: message,
            waittimes: waittimes.get(),
            toast: toast
        });
    });
};

function respond(req, res, message, data) {
    if (req.query.json) {
        res.json({message: message, data: data});
    } else {
        if (message) {
            res.cookie("toast", message);
        }
        res.redirect("/");
    }
}

function post_add(req, res) {
    var name = req.body.name;
    var user_id = req.body.user_id.toLowerCase();
    var topic_id = req.body.topic_id;
    var topic = null;
    new Promise(function(resolve, reject) {
        // A valid user ID is between 3 and 8 alphanumeric characters, and
        // if the user is logged in (and isn't a TA), then it must match
        // the account they're logged in with.
        if (!user_id || user_id.length < 3 || user_id.length > 8
                || !RegExp("^[A-Za-z0-9]*$").test(user_id)
                || (req.session && req.session.authenticated && !req.session.TA && req.session.user_id != user_id)) {
            throw new Error("Invalid Andrew ID");
        }
        // A valid name is just any non-empty string.
        if (!name || name.length < 1) {
            throw new Error("Invalid Name");
        }
        resolve();
    }).then(function() {
        // Make sure the user isn't already on the queue
        return model.Entry.findOne({
            where: {status: {lt: 2}, user_id: user_id},
        });
    }).then(function(result) {
        if (result) {
            throw new Error("You are already on the queue");
        } else {
            return model.Topic.findById(topic_id);
        }
    }).then(function(result) {
        if (result == null && topic_id == 0) {
            topic_id = null;
        } else if (result == null || result.out_date > new Date() || result.due_date < new Date()) {
            throw new Error("Please choose a topic from the list.");
        } else {
            topic = result;
        }
        // Make sure the queue isn't frozen
        return options.frozen();
    }).then(function(frozen) {
        if (frozen && (!req.session || !req.session.TA)) {
            throw new Error("The queue is not accepting signups right now");
        }
        // Create an unauthenticated session if the user isn't logged in or
        // if their existing session's user ID doesn't match the current one
        if (!req.session || (!req.session.TA && req.session.user_id != user_id)) {
            var key = crypto.randomBytes(72).toString('base64');
            return model.Session.create({
                name: name,
                user_id: user_id,
                session_key: key,
                authenticated: false
            }).then(function(instance) {
                req.session = instance;
                res.cookie("auth", key);
            });
        } else if (req.session && !req.session.TA) {
            return req.session.update({
                name: name
            }).then(function(instance) {
                req.session = instance;
            });
        }
    }).then(function() {
        // Finally, add the entry to the queue
        var times = waittimes.get();
        var estimate = null;
        if (times.length > 0) {
            estimate = times[times.length-1];
        }
        return model.Entry.create({
            user_id: user_id,
            name: name,
            entry_time: new Date(),
            wait_estimate: estimate,
            status: 0,
            session_id: req.session.TA ? null : req.session.id,
            topic_id: topic_id
        });
    }).then(function(instance) {
        entries_cache = null;
        instance.topic = topic
        realtime.add(instance);
        return waittimes.update();
    }).then(function(waittimes) {
        respond(req, res, "Entered the queue");
    }).catch(function(error) {
        respond(req, res, "Error: " + error.message);
    });
}

function post_rem(req, res) {
    var id = req.body.entry_id;
    var entry = null;

    // Find the entry that should be removed
    model.Entry.findById(id).then(function(instance) {
        if (!instance) {
            throw new Error("There is no entry with that ID");
        }
        entry = instance;
        // Only entries that have not yet been helped can be removed.
        // In order to remove an entry, you need to either be a TA or be
        // logged in as the student who matches the entry.
        if (entry.status == 0 && req.session
              && (req.session.id == entry.session_id
                  || (req.session.authenticated
                        && req.session.user_id == entry.user_id)
                  || req.session.TA)) {
            // entry can be removed
            return entry.destroy();
        } else {
            throw new Error("You don't have permission to remove that entry");
        }
    }).then(function() {
        realtime.remove(entry.id);
        entries_cache = null;
        return waittimes.update();
    }).then(function(waittimes) {
        respond(req, res, "Entry removed");
    }).catch(function(error) {
        respond(req, res, "Error: " + error.message);
    });
}

function post_help(req, res) {
    var id = req.body.entry_id;
    model.sql.transaction(function(t) {
        if (!req.session || !req.session.TA) {
            throw new Error("You don't have permission to help that student");
        }
        if (req.session.TA.helping_id) {
            throw new Error("You are already helping a student");
        }
        return model.Entry.findById(id, {
            transaction: t
        }).then(function(entry) {
            if (!entry) {
                throw new Error("The student you were trying to help is not on the queue");
            }
            if (entry.status != 0) {
                throw new Error("That student is already being helped");
            }
            return entry.update({
                status: 1,
                help_time: new Date(),
                ta_id: req.session.TA.id
            }, {transaction: t});
        }).then(function() {
            var num_today = req.session.TA.num_today;
            var time_today = req.session.TA.time_today;
            if (new Date() - req.session.TA.updated_at > 1000*60*60*12) {
                num_today = 0;
                time_today = 0;
            }
            return req.session.TA.update({
                helping_id: id,
                num_today: num_today,
                time_today: time_today
            }, {transaction: t});
        })
    }).then(function(result) {
        entries_cache = null;
        realtime.help(id, req.session.TA);
        return waittimes.update();
    }).then(function(waittimes) {
        respond(req, res, null);
    }).catch(function(error) {
        respond(req, res, "Error: " + error.message);
    });
}

function post_cancel(req, res) {
    var id = req.body.entry_id;
    var ta = null;
    model.sql.transaction(function(t) {
        if (!req.session || !req.session.TA) {
            throw new Error("You don't have permission to cancel helping that student");
        }
        return model.Entry.findById(id, {
            include: [{model: model.TA, as: "TA"}],
            transaction: t
        }).then(function(entry) {
            if (!entry || !entry.TA || entry.status != 1) {
                throw new Error("That student is not being helped");
            }
            ta = entry.TA;
            return entry.update({
                status: 0,
                help_time: null,
                ta_id: null
            }, {transaction: t});
        }).then(function(entry) {
            return ta.update({
                helping_id: null
            }, {transaction: t});
        })
    }).then(function(result) {
        entries_cache = null;
        realtime.cancel(id, ta.id);
        return waittimes.update();
    }).then(function(waittimes) {
        respond(req, res, null);
    }).catch(function(error) {
        respond(req, res, "Error: " + error.message);
    });
}

function post_done(req, res) {
    var id = req.body.entry_id;
    var ta = null;
    var message = null;
    var duration;
    model.sql.transaction(function(t) {
        if (!req.session || !req.session.TA) {
            throw new Error("You don't have permission to finish helping that student");
        }
        return model.Entry.findById(id, {
            include: [{model: model.TA, as: "TA"}],
            transaction: t
        }).then(function(entry) {
            if (!entry || !entry.TA || entry.status != 1) {
                throw new Error("That student is not being helped");
            }
            if (entry.TA.id != req.session.TA.id) {
                throw new Error("You don't have permission to finish helping that student");
            }
            ta = entry.TA;
            var exit_time = new Date();
            duration = (exit_time - entry.help_time)/1000;
            var mins = Math.round(duration/60.0);
            message = "Student helped for " + mins + " minute";
            if (mins != 1) message += "s";
            return entry.update({
                status: 2,
                exit_time: exit_time
            }, {transaction: t});
        }).then(function(entry) {
            return ta.update({
                helping_id: null,
                num_helped: ta.num_helped + 1,
                time_helped: ta.time_helped + duration,
                num_today: ta.num_today + 1,
                time_today: ta.time_today + duration
            }, {transaction: t});
        })
    }).then(function(result) {
        entries_cache = null;
        realtime.done(id, ta.id);
        return waittimes.update();
    }).then(function(waittimes) {
        respond(req, res, message);
    }).catch(function(error) {
        respond(req, res, "Error: " + error.message);
    });
}

exports.post = function(req, res) {
    var action = req.body.action;
    if (action == "ADD") {
        post_add(req, res);
    } else if (action == "REM") {
        post_rem(req, res);
    } else if (action == "HELP") {
        post_help(req, res);
    } else if (action == "CANCEL") {
        post_cancel(req, res);
    } else if (action == "DONE") {
        post_done(req, res);
    } else {
        respond(req, res, "Invalid action: " + action);
    }
};
