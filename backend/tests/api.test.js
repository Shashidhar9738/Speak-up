/**
 * Backend contract tests.
 *
 * The UI suite covers what the admin ends up looking at. Nothing covered what
 * the API actually returns, and every bug found in the request path — an
 * internal error message forwarded to the client, auth failures answering in a
 * shape nothing else used, a rate limiter that counted with a read followed by
 * a write, text fields accepting arrays — was invisible to a green test run.
 *
 * Run with: npm run test:api
 */

// Before anything reads config. The app resolves its database from
// SPEAKUP_DB_FILE at require time, so a test that sets any other variable and
// assumes isolation writes its fixtures into the real complaint database.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "speakup-api-test-"));
process.env.SPEAKUP_DB_FILE = path.join(SANDBOX, "test.db");
process.env.SPEAKUP_DATA_FILE = path.join(SANDBOX, "submissions.json");
process.env.SPEAKUP_ADMIN_SECRET = "test-secret-not-used-anywhere-real";
// The submission limiter must not fire during the validation tests below; the
// limiter has its own tests further down, driven directly.
process.env.SPEAKUP_SUBMISSION_RATE_MAX = "1000";
process.env.SPEAKUP_AUTH_RATE_MAX = "1000";

const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");

const app = require("../src/app");
const { createHttpError, errorHandler } = require("../src/middleware/errorMiddleware");
const { createRateLimiter } = require("../src/middleware/rateLimitMiddleware");
const db = require("../src/services/db");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  // Windows refuses to remove a directory holding an open file, and the app
  // keeps the database handle for the life of the process.
  db.close();
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch (error) {
    // A sandbox left behind in the temp directory is not worth failing a run.
  }
});

async function post(pathname, body, headers) {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function get(pathname, headers) {
  const response = await fetch(base + pathname, { headers: headers || {} });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Drives the error handler without a route, which is the only way to see what
// an unexpected throw turns into: every error the app raises on purpose is
// deliberately safe to show.
function render(error) {
  let result = null;
  const response = {
    status(code) { result = { status: code }; return this; },
    json(payload) { result.body = payload; return this; }
  };
  const log = console.error;
  console.error = () => {};
  try {
    errorHandler(error, {}, response, () => {});
  } finally {
    console.error = log;
  }
  return result;
}

/* ---------------------------------------------------------------- errors -- */

test("an unexpected internal error never reaches the client", () => {
  const leak = new Error("SQLITE_ERROR: no such column: password_hash in /srv/speakup/data/speakup.db");
  const result = render(leak);

  assert.equal(result.status, 500);
  assert.equal(result.body.error, "Internal server error");
  assert.ok(!/SQLITE_ERROR|speakup\.db|password_hash/.test(JSON.stringify(result.body)),
    "the driver's message was forwarded to the caller");
});

test("a 5xx raised on purpose keeps the message written for the caller", () => {
  const result = render(createHttpError(503, "Email delivery is not configured, so registration cannot be completed."));

  assert.equal(result.status, 503);
  assert.equal(result.body.error, "Email delivery is not configured, so registration cannot be completed.");
});

test("details are withheld on an unexpected 5xx and kept on a deliberate error", () => {
  const internal = Object.assign(new Error("boom"), { status: 500, details: { query: "SELECT * FROM users" } });
  assert.equal(render(internal).body.details, undefined);

  const deliberate = createHttpError(400, "messageText is required", { field: "messageText" });
  assert.deepEqual(render(deliberate).body.details, { field: "messageText" });
});

test("a status that is not a usable HTTP code becomes a 500 rather than throwing", () => {
  // response.status() rejects anything outside 100-999, and the handler that
  // crashes is the one meant to keep the process alive.
  assert.equal(render(Object.assign(new Error("x"), { status: "not-a-number" })).status, 500);
  assert.equal(render(Object.assign(new Error("x"), { status: 99999 })).status, 500);
  assert.equal(render(Object.assign(new Error("x"), { status: 0 })).status, 500);
});

test("an unmatched route answers in the shared error shape", async () => {
  const result = await get("/api/there-is-no-such-thing");

  assert.equal(result.status, 404);
  assert.match(result.body.error, /Route not found: GET \/api\/there-is-no-such-thing/);
});

/* ------------------------------------------------------------------ auth -- */

test("a missing token is refused in the same shape as every other error", async () => {
  const result = await get("/api/auth/me");

  assert.equal(result.status, 401);
  assert.equal(typeof result.body.error, "string");
  // The machine-readable cause belongs in details.reason. The client uses its
  // presence to tell a dead session from a refusal it should simply display.
  assert.equal(result.body.details.reason, "Malformed token");
});

test("a forged token is refused as an invalid signature", async () => {
  const result = await get("/api/auth/me", { Authorization: "Bearer forged.signature" });

  assert.equal(result.status, 401);
  assert.equal(result.body.details.reason, "Invalid signature");
});

test("a role refusal carries no reason, so it is not mistaken for a dead session", async () => {
  const result = await get("/api/auth/me");
  assert.ok(result.body.details, "auth failures must carry details.reason");

  // A refusal raised by a route rather than by requireAdmin.
  const roleRefusal = render(createHttpError(403, "Your role cannot export complaint data"));
  assert.equal(roleRefusal.body.details, undefined,
    "a role refusal with details.reason would sign the admin out");
});

/* ------------------------------------------------------- input handling -- */

test("a text field arriving as an array is rejected, not concatenated", async () => {
  // String(["aaaaaaaa","bbbbbbbb"]) is "aaaaaaaa,bbbbbbbb" — long enough to
  // clear the minimum-length check and be stored as somebody's complaint.
  const result = await post("/api/submissions", { messageText: ["aaaaaaaa", "bbbbbbbb"] });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /at least 10 characters/);
});

test("a text field arriving as an object is rejected", async () => {
  const result = await post("/api/submissions", { messageText: { length: 500 } });

  assert.equal(result.status, 400);
});

test("a password arriving as an array is rejected rather than coerced", async () => {
  const result = await post("/api/auth/login", { email: "someone@example.com", password: ["a", "b"] });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /Password is required/);
});

test("a repeated query parameter is rejected, since it parses to an array", async () => {
  // The query-string version of the same hole. Express 5 parses with node's
  // querystring, so bracket notation stays a literal key and it is the repeated
  // plain key that yields ["a@b.com", "c@d.com"] — which String() would have
  // joined into one plausible-looking address.
  const result = await get("/api/auth/registration-status?email=a@b.com&email=c@d.com");

  assert.equal(result.status, 400);
  assert.match(result.body.error, /email is required/);
});

test("an ordinary submission still succeeds", async () => {
  const result = await post("/api/submissions", {
    messageText: "The expense approval process has been stuck for three weeks.",
    department: "Finance"
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.submission.messageText,
    "The expense approval process has been stuck for three weeks.");
});

test("an optional field of the wrong type falls back to its default", async () => {
  const result = await post("/api/submissions", {
    messageText: "A perfectly ordinary report about the parking situation.",
    channel: ["web"]
  });

  // "" is not a valid channel, so the default applies — the same outcome as
  // omitting the field, which is what a field of the wrong type amounts to.
  assert.equal(result.status, 201);
  assert.equal(result.body.submission.channel, "web");
});

/* -------------------------------------------------------------- inventory -- */

function registeredRoutes() {
  const routes = [];
  for (const layer of app.router.stack) {
    if (!layer.route || !layer.route.path.startsWith("/api/")) { continue; }
    for (const method of Object.keys(layer.route.methods)) {
      routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return routes.sort();
}

test("the inventory lists every route the app actually serves", async () => {
  // The hand-written version of this list had fallen a route behind —
  // GET /api/admin/roles was served but undocumented — with nothing to notice.
  const result = await get("/api/todo/apis");

  assert.equal(result.status, 200);
  const listed = result.body.implemented.map((entry) => `${entry.method} ${entry.path}`).sort();
  assert.deepEqual(listed, registeredRoutes());
});

test("every route in the inventory says what it is for", async () => {
  const result = await get("/api/todo/apis");

  const undescribed = result.body.implemented
    .filter((entry) => !entry.purpose)
    .map((entry) => `${entry.method} ${entry.path}`);

  assert.deepEqual(undescribed, [],
    "these routes need an entry in ROUTE_PURPOSE in backend/src/app.js");
});

/* ------------------------------------------------------------ rate limit -- */

// Driven directly rather than over HTTP: every request in this file shares one
// client address, so an HTTP-based limiter test would be counting the other
// tests' requests too.
function drive(limiter, key) {
  const headers = {};
  const request = { ip: key };
  const response = { setHeader(name, value) { headers[name] = value; } };
  let error = null;
  limiter(request, response, (value) => { error = value || null; });
  return { headers, error };
}

test("the counter increments per request and refuses past the limit", () => {
  const limiter = createRateLimiter({ name: "test-basic", windowMs: 60000, maxRequests: 3 });
  const key = "client-" + Date.now();

  assert.equal(drive(limiter, key).error, null);
  assert.equal(drive(limiter, key).error, null);

  const third = drive(limiter, key);
  assert.equal(third.error, null);
  assert.equal(third.headers["X-RateLimit-Remaining"], "0");

  const fourth = drive(limiter, key);
  assert.equal(fourth.error.status, 429);
});

test("each client gets its own allowance", () => {
  const limiter = createRateLimiter({ name: "test-isolated", windowMs: 60000, maxRequests: 1 });
  const stamp = Date.now();

  assert.equal(drive(limiter, "a-" + stamp).error, null);
  assert.equal(drive(limiter, "b-" + stamp).error, null, "one client's requests spent another's allowance");
});

test("the allowance returns once the window has passed", async () => {
  const limiter = createRateLimiter({ name: "test-window", windowMs: 120, maxRequests: 1 });
  const key = "client-" + Date.now();

  assert.equal(drive(limiter, key).error, null);
  assert.equal(drive(limiter, key).error.status, 429);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(drive(limiter, key).error, null, "the window never rolled over");
});

test("reset is advertised in seconds, and a refusal says how long to wait", () => {
  const limiter = createRateLimiter({ name: "test-headers", windowMs: 60000, maxRequests: 1 });
  const key = "client-" + Date.now();

  const allowed = drive(limiter, key);
  const reset = Number(allowed.headers["X-RateLimit-Reset"]);
  // Seconds since the epoch is 10 digits until the year 2286; milliseconds is
  // 13, which clients read as a date tens of thousands of years out.
  assert.equal(String(reset).length, 10, "X-RateLimit-Reset is not in seconds");
  assert.ok(Math.abs(reset - Date.now() / 1000) < 120);

  const refused = drive(limiter, key);
  assert.equal(refused.error.status, 429);
  const retryAfter = Number(refused.headers["Retry-After"]);
  assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After should be a short delay in seconds, got ${retryAfter}`);
});
