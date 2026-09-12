var crypto = require("crypto");
var model = require("./model.js");
var config = require("./config.json");

var sio;
var ta_room = crypto.randomBytes(72).toString('base64');
var student_room = crypto.randomBytes(72).toString('base64');

exports.seq = 0;

// Minimal Cookie header parser.  We can't use req.cookies here because a
// socket handshake doesn't go through the express middleware stack.
function parse_cookies(header) {
    var out = {};
    if (!header) {
        return out;
    }
    header.split(";").forEach(function(pair) {
        var eq = pair.indexOf("=");
        if (eq < 0) {
            return;
        }
        var name = pair.slice(0, eq).trim();
        var value = pair.slice(eq + 1).trim();
        try {
            out[name] = decodeURIComponent(value);
        } catch (e) {
            out[name] = value;
        }
    });
    return out;
}

exports.init = function(app) {
    sio = require("socket.io")(app, {path: config.path + "/socket.io"});

    sio.on("connection", function(socket) {
        socket.join(student_room);

        // The session key is read out of the handshake's own Cookie header
        // rather than being sent to us by the client.  That keeps the auth
        // cookie httpOnly, and means a client can only ever authenticate as
        // whoever the browser actually has a cookie for.
        var auth = parse_cookies(socket.handshake.headers.cookie).auth;
        if (!auth) {
            return;
        }
        model.Session.findOne({
            where: {session_key: String(auth)},
            include: [{model: model.TA, as: "TA"}]
        }).then(function(user) {
            if (user) {
                socket.session = user;
                if (user.TA || user.owner) {
                    socket.leave(student_room);
                    socket.join(ta_room);
                }
            }
        }).catch(function(err) {
            console.error("ERROR: socket authentication failed:", err.message);
        });
    });
};

exports.add = function(entry) {
    exports.seq = exports.seq + 1;
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.to(student_room).emit("add", {
        seq: exports.seq,
        id: entry.id,
        status: entry.status,
        ta_full_name: entry.TA ? entry.TA.full_name : null
    });
    sio.to(ta_room).emit("add", {
        seq: exports.seq,
        id: entry.id,
        data: {
            id: entry.id,
            status: entry.status,
            name: entry.name,
            user_id: entry.user_id,
            ta_id: entry.TA ? entry.TA.id : null,
            topic_name: entry.topic ? entry.topic.name : "other",
            ta_full_name: entry.TA ? entry.TA.full_name : null,
            question: entry.question,
            cooldown_override:entry.cooldown_override,
        }
    });
};

exports.remove = function(entry_id) {
    exports.seq = exports.seq + 1;
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.emit("remove", {
        seq: exports.seq,
        id: entry_id
    });
};

// All connected sockets, across socket.io 2.x (plain object) and 3.x+ (Map).
function all_sockets() {
    var sockets = sio.sockets.sockets;
    if (sockets && typeof sockets.forEach === "function" && typeof sockets.get === "function") {
        return Array.from(sockets.values());
    }
    return Object.keys(sockets).map(function(id) { return sockets[id]; });
}

// Whether this socket belongs to the student the entry is for.  Mirrors the
// condition home.ejs uses to decide an entry is "mine", so exactly the
// clients that will open the help modal are the ones told the meeting URL.
function is_entry_owner(socket, entry) {
    if (!entry || !socket.session) {
        return false;
    }
    if (entry.session_id != null && socket.session.id == entry.session_id) {
        return true;
    }
    return !!(socket.session.authenticated && entry.user_id
              && socket.session.user_id == entry.user_id);
}

exports.help = function(entry_id, ta, entry) {
    exports.seq = exports.seq + 1;
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    // Everyone needs to know the entry is being helped and by whom, but the
    // TA's personal meeting URL goes only to the student they're helping --
    // it used to be broadcast to every connected client.
    var payload = {
        seq: exports.seq,
        id: entry_id,
        data: {
            ta_id: ta.id,
            ta_full_name: ta.full_name
        }
    };
    var with_url = {
        seq: exports.seq,
        id: entry_id,
        data: {
            ta_id: ta.id,
            ta_full_name: ta.full_name,
            ta_video_chat_url: ta.video_chat_url
        }
    };
    all_sockets().forEach(function(socket) {
        socket.emit("help", is_entry_owner(socket, entry) ? with_url : payload);
    });
};

exports.request_update = function(entry_id) {
    exports.seq = exports.seq + 1;
    if(!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.emit("request-update", {
        seq: exports.seq,
        id: entry_id
    });
};

exports.update = function(entry_id, updated_question) {
    exports.seq = exports.seq + 1;
    if(!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    
    // Students: only need to update seq
    sio.to(student_room).emit("update-question", {
        seq: exports.seq
    });

    // TAs: need to pass the updated question
    sio.to(ta_room).emit("update-question", {
        seq: exports.seq,
        id: entry_id,
        updated_question: updated_question
    });
};

exports.cancel = function(entry_id, ta_id) {
    exports.seq = exports.seq + 1;
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.emit("cancel", {
        seq: exports.seq,
        id: entry_id,
        data: {
            ta_id: ta_id
        }
    });
};

exports.done = function(entry_id, ta_id) {
    exports.seq = exports.seq + 1;
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.emit("done", {
        seq: exports.seq,
        id: entry_id,
        data: {
            ta_id: ta_id
        }
    });
};

exports.option = function(key, value) {
    exports.seq = exports.seq + 1;
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.emit("option", {
        seq: exports.seq,
        key: key,
        value: value
    });
}

exports.waittimes = function(times) {
    exports.seq = exports.seq + 1;
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.emit("waittimes", {
        seq: exports.seq,
        times: times
    });
}

// Takes in a list of tas to notify about their help time
exports.notifytime = function(notif_tas) {
    if (!sio) {
        console.log("ERROR: Socket.io is not initialized yet");
        return;
    }
    sio.to(ta_room).emit("notifytime", {
        notif_tas: notif_tas
    });
}
