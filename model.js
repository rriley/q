var Sequelize = require('sequelize');
var config = require("./config.json");
var sequelize = new Sequelize(
    process.env.MYSQL_DATABASE || config.mysql_db,
    process.env.MYSQL_USER || config.mysql_user,
    process.env.MYSQL_PASSWORD || config.mysql_pass, {
    dialect: 'mysql',
    host: process.env.MYSQL_HOST || config.mysql_host || 'localhost',
    logging: false,
    underscored: true,
    // Sequelize resolves this with moment-timezone, so an IANA zone name is
    // what it wants when stringifying dates.
    timezone: config.timezone,
    dialectOptions: {
        // mysql2, however, only accepts an offset ("+05:00"), "Z" or "local",
        // and was warning that it would eventually throw on the zone name
        // above.  It has been silently falling back to its "local" default all
        // along, and the process runs with TZ set to config.timezone, so saying
        // "local" explicitly keeps today's behaviour and removes the warning.
        timezone: 'local'
    }
});

exports.sql = sequelize;


// Tables

exports.Session = sequelize.define("session", {
    "name": Sequelize.STRING,
    "email": Sequelize.STRING,
    "user_id": Sequelize.STRING,
    "session_key": {type: Sequelize.STRING, unique: true},
    "authenticated": Sequelize.BOOLEAN,
    "owner": Sequelize.BOOLEAN
}, {
    underscored: true
});

exports.TA = sequelize.define("tas", {
    "email": Sequelize.STRING,
    "full_name": Sequelize.STRING,
    "video_chat_url": Sequelize.STRING,
    "semester": Sequelize.STRING,
    "time_helped": Sequelize.INTEGER,
    "num_helped": Sequelize.INTEGER,
    "time_today": Sequelize.INTEGER,
    "num_today": Sequelize.INTEGER,
    "admin": Sequelize.BOOLEAN
}, {
    tableName: 'tas',
    underscored: true
});

exports.Entry = sequelize.define("entry", {
    "user_id": Sequelize.STRING,
    "name": Sequelize.STRING,
    "semester": Sequelize.STRING,
    "entry_time": Sequelize.DATE,
    "help_time": Sequelize.DATE,
    "exit_time": Sequelize.DATE,
    "wait_estimate": Sequelize.INTEGER,
    "status": Sequelize.INTEGER,  //0: on queue, 1: being helped, 2: helped
    "question": Sequelize.STRING,
    "cooldown_override": Sequelize.BOOLEAN,
    "update_requested": Sequelize.BOOLEAN
}, {
    timestamps: false,
    underscored: true
});

exports.Topic = sequelize.define("topic", {
    "name": Sequelize.STRING,
    "out_date": Sequelize.DATE,
    "due_date": Sequelize.DATE,
    "semester": Sequelize.STRING
}, {
    underscored: true
});

exports.Option = sequelize.define("option", {
    "key": {type: Sequelize.STRING, unique: true},
    "value": Sequelize.STRING
}, {
    underscored: true
});

// Relationships

exports.Entry.belongsTo(exports.Session, {
    foreignKey: "session_id"
});
exports.Entry.belongsTo(exports.Topic, {
    foreignKey: "topic_id"
});
exports.Topic.hasMany(exports.Entry);
exports.Entry.belongsTo(exports.TA, {
    as: "TA",
    foreignKey: "ta_id"
});
exports.Session.belongsTo(exports.TA, {
    as: "TA",
    foreignKey: "ta_id"
});
exports.TA.belongsTo(exports.Entry, {
    as: 'helping_entry',
    foreignKey: 'helping_id',
    constraints: false
});
