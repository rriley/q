var config = require("../config.json");

exports.get = function(req, res) {
    res.set ('Content-Type', 'application/json');
    res.render("manifest", {
        title: config.title,
        short_title: config.short_title,
        path: config.path
    });
}