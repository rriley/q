// Resolves an object whose values are promises into an object of results:
//
//     props({a: p1, b: p2}).then(function(r) { r.a; r.b; })
//
// This replaces Sequelize.Promise.props.  Sequelize 5 exposed bluebird as
// Sequelize.Promise; Sequelize 6 uses native promises and dropped it.
exports.props = function(obj) {
    var keys = Object.keys(obj);
    return Promise.all(keys.map(function(key) {
        return obj[key];
    })).then(function(values) {
        var resolved = {};
        keys.forEach(function(key, i) {
            resolved[key] = values[i];
        });
        return resolved;
    });
};

// Serialises a value for embedding inside an inline <script> block.
//
// JSON.stringify does not escape "</", so a string containing "</script>"
// would close the block early and everything after it would be parsed as
// markup.  Two of the three call sites in home.ejs had this escaping inlined
// and the third didn't; this exists so they can't drift apart again.
exports.json_for_script = function(value) {
    return JSON.stringify(value).replace(/<\//g, "<\\/");
};
