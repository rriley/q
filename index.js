#!/usr/bin/env node

var config = require("./config.json");
process.env.TZ = config.timezone;

var http = require('http');
var express = require('express');
var cookieParser = require('cookie-parser');
var model = require("./model.js");
var realtime = require("./realtime.js");
var notiftime = require("./notiftime.js");
var waittimes = require("./waittimes.js");
var csrf = require("./csrf.js");
var security = require("./security.js");

var login = require("./routes/login.js");
var home = require("./routes/home.js");
var options = require("./routes/options.js");
var metrics = require("./routes/metrics.js");
var history = require("./routes/history.js");
var gettime = require("./routes/gettime.js");
var settings = require("./routes/settings.js");
var manifest = require("./routes/manifest.js");

var app = express();
var server = http.Server(app);
realtime.init(server);
app.set('view engine', 'ejs')
// Security headers first, so they're set even on responses that
// short-circuit later (static files, redirects, errors).
app.use(security.nonce);
app.use(security.headers);
// express.urlencoded is body-parser, bundled with express since 4.16,
// so the versions can no longer drift apart.
app.use(express.urlencoded({"extended": false}));
app.use(cookieParser());
app.use(config.path, express.static('static'));
// After the static mount (static files need no token) and after
// bodyParser/cookieParser, which it reads from.
app.use(csrf.middleware);
app.use(function(req, res, next) {
    if (!req.cookies.auth) {
        next();
        return;
    }
    model.Session.findOne({
        where: {session_key: req.cookies.auth},
        include: [{model: model.TA, as: "TA"}]
    }).then(function(user) {
        req.session = user;
        next();
    }).catch(next);
});

app.get(config.path+"/", home.get);
app.post(config.path+"/", home.post);

app.get(config.path+"/login", login.get_login);
app.get(config.path+"/oauth2/callback", login.get_callback);
app.get(config.path+"/logout", login.get_logout);

app.get(config.path+"/options", options.get);
app.post(config.path+"/options", options.post);

app.get(config.path+"/waittime", gettime.get);

app.get(config.path+"/metrics", metrics.get);
app.get(config.path+"/metrics/counts.json", metrics.get_counts);

app.get(config.path+"/history", history.get);

app.get(config.path+"/settings", settings.get);
app.post(config.path+"/settings", settings.post);

app.get(config.path+"/manifest.json", manifest.get);

// Catch-all error handler.  Without this, anything a route forwards to next()
// renders express's default stack-trace page.
app.use(function(err, req, res, next) {
    console.error("ERROR: unhandled error serving " + req.method + " " + req.url + ":",
                  (err && err.stack) || err);
    if (res.headersSent) {
        return next(err);
    }
    res.sendStatus(500);
});

// A rejected promise that nobody handles terminates the process on modern
// node.  Log it and keep serving rather than dropping the queue mid-session.
process.on("unhandledRejection", function(reason) {
    console.error("ERROR: unhandled promise rejection:", (reason && reason.stack) || reason);
});

// Sync the schema once at startup instead of on every single request.
model.sql.sync().then(function() {
    notiftime.init();
    waittimes.init();
    server.listen(config.server_port);
}).catch(function(error) {
    console.error("FATAL: could not sync the database schema:", (error && error.stack) || error);
    process.exit(1);
});
