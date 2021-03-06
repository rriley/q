#!/usr/bin/env node

var config = require("./config.json");
process.env.TZ = config.timezone;

var http = require('http');
var express = require('express');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var model = require("./model.js");
var realtime = require("./realtime.js");
var waittimes = require("./waittimes.js");

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
waittimes.init();
app.set('view engine', 'ejs')
app.use(bodyParser.urlencoded({"extended": false}));
app.use(cookieParser());
app.use(config.path, express.static('static'));
app.use(function(req, res, next) {
    model.sql.sync().then(function() {
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
        });
    });
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

server.listen(config.server_port);
