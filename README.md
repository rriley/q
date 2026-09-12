# 15-122 Office Hours Queue

## Gather Necessary Information

In order to install the Queue application, you'll need to create a MySQL database and user, and obtain Google OAuth credentials. After installing MySQL (directions for Ubuntu can be found [here](https://www.digitalocean.com/community/tutorials/how-to-install-mysql-on-ubuntu-16-04). Other platforms: Google it), you can run the following sequence of commands to create a database and a user that has permission to access it:

1. `$ mysql -u root -p` (and enter the MySQL root password which you created during installation)
2. `mysql> CREATE DATABASE queue;`
3. `mysql> CREATE USER 'your_username'@'localhost' IDENTIFIED BY 'your_password';` (make sure to choose a strong password)
4. `mysql> GRANT ALL PRIVILEGES ON queue.* TO 'your_username'@'localhost';`

To get Google OAuth credentials, you can follow the instructions at [https://developers.google.com/adwords/api/docs/guides/authentication#webapp](https://developers.google.com/adwords/api/docs/guides/authentication#webapp). Leave the "Authorized JavaScript origins" field blank, and use `https://<YOUR_DOMAIN>/oauth2/callback` for the Authorized Redirect URI. (if you're not using HTTPS, replace `https` with `http`).

If you have a Slack team set up for your course, you can set up a Slack Incoming Webhook [here](https://my.slack.com/services/new/incoming-webhook/). Otherwise, you may leave the `slack_webhook` field empty in the config file.

## Install

1. Install [Node.js](https://nodejs.org) — version 22.12 or newer is required
   (`sanitize-html` and `googleapis` both refuse older releases). The Docker
   image builds on `node:24-alpine`.
2. Clone this repository
3. In the root directory, create the file `config.json` with the following structure
   (if you're running with Docker Compose instead, skip the `mysql_host`/`mysql_db`/
   `mysql_user`/`mysql_pass` fields — see below):
   ```
   {
       "title": "15-122 Office Hours Queue",
       "protocol": "http",
       "domain": "q.15122.tk",
       "path": "",
       "timezone": "America/New_York",
       "server_port": 80,

       "mysql_host": "localhost",
       "mysql_db": "<Your MySQL database>",
       "mysql_user": "<MySQL user that has access to the database>",
       "mysql_pass": "<Password for the MySQL user>",

       "google_id": "<Google Client ID from https://console.developers.google.com>",
       "google_secret": "<Google Client Secret from https://console.developers.google.com>",

       "allowed_domain": "andrew.cmu.edu",

       "owner_email": "<Google/Andrew account email address for this site's Owner (super-user)>"
   }
   ```

   `allowed_domain` is the Google Workspace domain that accounts must belong to.
   Sign-ins from any other domain are rejected, which is what stops someone with
   a personal Google account from being treated as the student who happens to
   share their address's local part. It defaults to `andrew.cmu.edu`; set it to
   `""` to accept any Google account. The address in `owner_email` is always
   allowed through, so it can be a personal account.
4. Run this command in your terminal:

   ```
   npm install
   ```

## Set up and run

This part is up to you. If port 80 is already being used (for another web server, for example), you can [set up Nginx as a reverse proxy](https://www.nginx.com/resources/admin-guide/reverse-proxy/) and use a different port in `config.json`. Once you have properly configured your environment, use the following command to run the server:
```
node index.js
```
You can also use [pm2](http://pm2.keymetrics.io/) to manage the server process to ensure that it's always running.

## Run with Docker Compose

1. Create `config.json` as described above, but omit `mysql_host`, `mysql_db`, `mysql_user`
   and `mysql_pass` — Docker Compose supplies fixed database credentials to the app
   container automatically (the database isn't reachable from outside the containers, so
   there's nothing to keep secret there). Keep `"server_port"` set to whatever port you
   want to expose (defaults to `15122` if you don't set the `APP_PORT` environment variable).
2. Run:
   ```
   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up --build
   ```
   This starts a MySQL container and the app container, which connects to it automatically.
   The database persists in `./data`, owned by the user who ran the command above (passing
   `HOST_UID`/`HOST_GID` makes the MySQL container run as that user instead of the image's
   default, so the files aren't left owned by a container-internal user id). Note: don't
   name these variables `UID`/`GID` — those are read-only shell variables in bash, so
   `UID=... docker compose up` silently fails to pass the value through.

## Running the tests

`test/` holds regression tests for the security fixes -- the escaping in
`static/js/client.js`, CSRF, the OAuth domain check, the Content-Security-Policy,
and the socket room separation. They exist because most of those are the kind of
thing that breaks silently: a `.text()` quietly changed back to `.html()` still
renders fine, it just becomes exploitable again.

```
npm install       # the suites need the devDependencies
npm test
```

`test/run.sh` starts a MySQL container and a copy of the app in a temporary
directory, seeds a semester and a TA, runs every suite, and tears it all down.
Your own `config.json` and database are never touched. It needs `docker`; the
two browser suites additionally need Chrome or Chromium and are skipped with a
warning if neither is found (set `CHROME_PATH` if yours is somewhere unusual).

Run a subset by name:

```
npm test -- xss csp
```

| suite | what it covers |
| --- | --- |
| `xss-render` | Feeds XSS payloads through the real entry builders in a DOM |
| `oauth-domain` | The domain/verified-email decision table |
| `oauth-roundtrip` | The token exchange against a stand-in for Google |
| `date-roundtrip` | Dates survive Sequelize/mysql2 without a timezone shift |
| `session-expiry` | Sessions stop authenticating past their lifetime, and get swept |
| `http-flows` | CSRF, the open redirect, URL validation, authorization, logout, SRI |
| `socket-rooms` | TAs and students receive different payloads |
| `help-scope` | Only the student being helped gets the TA's meeting URL |
| `browser-csp` | Real Chrome: no CSP violations, injected scripts refused |
| `browser-ui` | Real Chrome: signup and the converted click handlers work |

The jQuery devDependency is pinned to the exact version `views/head.ejs` loads
from the CDN (currently 3.7.1), so `xss-render` exercises the escaping against what actually runs
in production. If you change one, change the other.

## Add your information

In a web browser, go to the domain you specified in the configuration. If everything was set up correctly, you should see a splash page that says the installation was successful.

Log into the account with the email address you specified as the `owner_email` in the configuration to finish the setup. You'll be taken to the admin page, where you should set the current semester and add admins, TAs and topics. If you're planning to help students, you must add yourself to the list as an admin (being the owner is not enough).
