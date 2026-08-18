# Working on SpeakUp

The README explains what this product does and how a report moves through it.
This file is the other half: the things that are not visible from reading the
code, and the mistakes that have already been made once here.

Read it before touching the backend. Most of it exists because something went
wrong in a way that looked fine at the time.

---

## The one that will bite you

**Anything that boots the app writes to the real complaint database unless you
set `SPEAKUP_DB_FILE` first.**

`backend/src/config.js` resolves the database path once, at require time, from
`SPEAKUP_DB_FILE`, falling back to `backend/data/speakup.db`. There is no other
variable. Setting `DATA_DIR`, or `NODE_ENV=test`, or anything else you might
reasonably assume, isolates nothing — the app opens the live file and your
fixtures land among real reports.

This has happened. Two smoke-test submissions ended up in the production
database and had to be picked out by id afterwards.

So in any test, script, or throwaway file that requires `app.js`:

```js
process.env.SPEAKUP_DB_FILE = path.join(sandbox, "test.db");   // BEFORE the require
const app = require("../src/app");
```

`backend/tests/api.test.js` does this at the top of the file and says why. Copy
that pattern. If you are about to run something that touches the database and
you have not set that variable, you are about to write to production.

On Windows the sandbox will not delete while the app holds the handle — call
`db.close()` before `fs.rmSync`, and wrap the removal in a try/catch, which is
what the test teardown does.

---

## Running it

```bash
npm install
npm start          # http://127.0.0.1:3000, serves API and pages together
npm run dev        # same, restarts on change
npm test           # all 77 tests
```

`npm test` lists its three files explicitly rather than passing the directory.
That is deliberate: `node --test backend/tests/` fails on this Node build,
trying to resolve the directory as a module. If you add a test file, add it to
the script.

The three suites are different animals. `ui.test.js` loads each page in jsdom
with a stubbed API and asserts what a user actually ends up looking at — it
exists because a bug shipped three times where the API was correct, the HTML
was correct, and the screen was wrong. `api.test.js` boots the real server and
checks the HTTP contract. `client.test.js` runs `assets/api.js` in a VM against
a fake fetch.

There is no linter and no formatter — match the surrounding file. Node 24, no
build step for the backend, no framework beyond Express. `npm run build` is a
PowerShell script that assembles `dist/` for static hosting; it is not part of
running or testing the API.

---

## Express 5, not 4

Worth knowing because the differences are quiet:

- **Async errors forward automatically.** An `async` route handler that rejects
  reaches the error middleware on its own. No wrapper needed.
- **The query parser is `simple`, not `qs`.** `?tags[]=a&tags[]=b` gives you a
  literal `"tags[]"` key, and `request.query.tags` is undefined. A *repeated*
  plain key — `?tags=a&tags=b` — is what produces an array. A test was written
  against the wrong one of these and passed for the wrong reason.
- `app.router` is the router; `app._router` is gone.

---

## Conventions that are load-bearing

**Errors go through `next(createHttpError(...))`.** Never write an error
response directly. The handler in `errorMiddleware.js` sends `{ error }` plus
optional `{ details }`, and it only reveals a message when the error carries
`expose: true`, which `createHttpError` sets. Anything else that reaches it —
a driver error, a parser, a mail client — is logged and answered with a flat
"Internal server error", because those messages carry connection strings and
file paths. If you throw a 5xx you want the user to read, build it with
`createHttpError`.

`details.reason` on a 401 or 403 is not decoration. `assets/api.js` uses its
presence to decide whether the session is dead. Auth failures carry it; role
refusals ("your role cannot export") must not, or the admin gets signed out and
told their session expired when it did not.

**Read request text with `readText` / `normalizeText`,** from
`validationMiddleware.js`. Never `String(request.body?.x || "")`. `String()` on
an array gives you `"aaaaa,bbbbb"`, which sails through a minimum-length check
and gets stored as somebody's complaint. Those helpers return `""` for anything
that is not a string, which every caller already treats as missing. Passwords
use `readText` specifically — `normalizeText` trims, and trimming a password
silently changes it.

**Comments explain the failure mode, not the mechanism.** The code says what it
does; the comment says what goes wrong without it. Look at `tokenService.js` or
the rate limiter for the register. A comment that restates the line below it is
worse than none.

**Commit messages are prose.** A subject line, then paragraphs explaining what
was wrong and why the fix is shaped the way it is. Not bullet lists.

---

## Deployment: two halves

The pages are static on **GitHub Pages**; the API runs on **Render**. They are
on different origins, which is the source of most deployment surprises.

- `assets/api.js` calls the Render URL when it sees it is running on
  `github.io`, and stays same-origin otherwise so a local `npm start` works
  unchanged. `window.SPEAKUP_API_BASE` overrides both.
- `SPEAKUP_CORS_ORIGIN` on Render must be the Pages origin or the browser
  refuses every request.
- `SPEAKUP_HOST=0.0.0.0` is required. The default is `127.0.0.1`, and on Render
  that means the deploy succeeds, the logs look healthy, and nothing can reach
  it.
- **Auto-deploy does not fire.** The service was created through the API and has
  no GitHub webhook, so pushing does nothing until a deploy is triggered
  manually. Connect the repo in Render's dashboard if you want this fixed.
- `demo-mode.js` substitutes sample data when no backend exists, which is what
  the Pages link used to be. It asks `api.js` where the client actually talks
  before deciding. It must never stand in for a live deployment — an error is
  honest, invented complaints are not.

**The free tier has no persistent disk.** Every deploy wipes the database:
reports, accounts, audit log, all of it. This is unresolved. Fixing it means
moving the data off the container — Turso keeps the SQL dialect and needs the
driver made async, Litestream needs no code change at all — and either way it
needs an account that does not exist yet.

---

## Things that look wrong and are not

- **The audit trail is a file, not a table.** A trail the app can rewrite is not
  a trail. See `auditService.js`.
- **Linked reports are never merged.** Each reporter keeps their own thread and
  access code. Combining them would put several people into one conversation
  where any of them could read the others.
- **No column identifies a reporter.** The access code exists only as a SHA-256
  hash. That is what makes a report unlinkable to a person even with the
  database in hand. Do not add a "just for support" identifier.
- **The frontend is served from an explicit allowlist,** not
  `express.static(root)`. The project root holds `.env`, `node_modules` and the
  complaint database.
- **`buildApiInventory()` walks the router.** Endpoint lists maintained by hand
  drift; this one had fallen a route behind before anyone noticed. Add the
  description to `ROUTE_PURPOSE` — a test fails if a route has none.

---

## Repo housekeeping

Files are CRLF. Scripts that rewrite source by matching multi-line strings need
to account for it, or they will silently find nothing and report success.

`dist/`, `node_modules/`, `backend/data/`, `.env` and `CREDENTIALS.md` are
ignored, and the repository is public. Nothing from `backend/data/` may ever be
committed: it holds complaint text and password hashes, and git history keeps
what you delete.
