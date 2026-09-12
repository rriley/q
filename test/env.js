// Shared configuration for the test suites.
//
// Everything is overridable by environment variable so the suites can run
// against an instance you started yourself; test/run.sh sets these when it
// brings up its own throwaway stack.
var fs = require("fs");
var path = require("path");

var PORT = process.env.QUEUE_TEST_PORT || "15122";

exports.REPO = path.join(__dirname, "..");
// The app instance under test.  run.sh points this at a temporary copy of the
// repo so it can drop in a test config.json without touching yours.
exports.APP = process.env.QUEUE_TEST_APP || exports.REPO;
exports.BASE = process.env.QUEUE_TEST_URL || "http://127.0.0.1:" + PORT;
exports.HOST = exports.BASE.replace(/^https?:\/\//, "");
// Seeded by run.sh; a TA + admin session key.
exports.TA_KEY = process.env.QUEUE_TEST_TA_KEY || "TESTTAKEY123";
exports.TA_COOKIE = "auth=" + exports.TA_KEY;

// Chrome is only needed by the two browser suites.  Returns null when there
// isn't one, so the runner can skip them rather than fail.
exports.chrome = function() {
    if (process.env.CHROME_PATH) {
        return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
    }
    var candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ];
    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) {
            return candidates[i];
        }
    }
    return null;
};

// Small reporter shared by the node suites.
exports.reporter = function() {
    var failures = 0;
    return {
        ok: function(condition, message) {
            console.log("  " + (condition ? "PASS" : "FAIL") + "  " + message);
            if (!condition) failures++;
        },
        done: function() {
            console.log(failures === 0 ? "\nAll checks passed." : "\n" + failures + " FAILURES");
            process.exit(failures ? 1 : 0);
        }
    };
};
