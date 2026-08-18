/**
 * API client tests.
 *
 * assets/api.js decides, for every failed request, whether the admin still has
 * a session. It used to decide on the status code alone, so a 403 meaning "your
 * role cannot export complaint data" and a 401 meaning "that is not your current
 * password" both destroyed a perfectly good session and blamed an expiry that
 * had not happened. These tests pin the distinction it draws instead.
 *
 * Run with: npm run test:client
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "assets", "api.js"), "utf8");

/**
 * Load the real client against a stubbed fetch, with a session already in
 * place, and report what is left of that session afterwards.
 */
function withResponse({ status, payload }) {
  const storage = {
    "speakup.admin.token": "a-valid-looking-token",
    "speakup.admin.email": "lead@example.com"
  };
  const win = {
    localStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      setItem: (key, value) => { storage[key] = value; },
      removeItem: (key) => { delete storage[key]; }
    },
    location: { href: "index.html" },
    fetch: async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(payload)
    })
  };
  win.window = win;

  const context = vm.createContext(win);
  context.fetch = win.fetch;
  vm.runInContext(SOURCE, context);

  return {
    api: win.SpeakUpApi,
    stillSignedIn: () => Boolean(storage["speakup.admin.token"]),
    redirected: () => win.location.href !== "index.html"
  };
}

async function callAndCatch(api) {
  try {
    await api.me();
    return null;
  } catch (error) {
    return error;
  }
}

test("an expired token signs the admin out and returns them to the login page", async () => {
  const client = withResponse({
    status: 401,
    payload: { error: "Your session is not valid. Please sign in again.", details: { reason: "Token expired" } }
  });

  const error = await callAndCatch(client.api);

  assert.match(error.message, /sign in again/);
  assert.equal(client.stillSignedIn(), false);
  assert.equal(client.redirected(), true);
});

test("a revoked account signs the admin out even though the token is intact", async () => {
  const client = withResponse({
    status: 403,
    payload: { error: "Access for this account has been revoked.", details: { reason: "revoked" } }
  });

  await callAndCatch(client.api);

  assert.equal(client.stillSignedIn(), false);
  assert.equal(client.redirected(), true);
});

test("a role refusal is shown to the admin, who stays signed in", async () => {
  const client = withResponse({
    status: 403,
    payload: { error: "Your role cannot export complaint data" }
  });

  const error = await callAndCatch(client.api);

  assert.equal(error.message, "Your role cannot export complaint data",
    "the refusal was replaced with a session-expiry message");
  assert.equal(client.stillSignedIn(), true, "a role refusal destroyed a working session");
  assert.equal(client.redirected(), false);
});

test("a wrong current password does not end the session", async () => {
  // This route is behind requireAdmin and answers 401, so a status-only rule
  // signs the admin out for a typo.
  const client = withResponse({
    status: 401,
    payload: { error: "Current password is incorrect" }
  });

  const error = await callAndCatch(client.api);

  assert.equal(error.message, "Current password is incorrect");
  assert.equal(client.stillSignedIn(), true);
  assert.equal(client.redirected(), false);
});

test("a server error leaves the session alone", async () => {
  const client = withResponse({ status: 500, payload: { error: "Internal server error" } });

  const error = await callAndCatch(client.api);

  assert.equal(error.message, "Internal server error");
  assert.equal(client.stillSignedIn(), true);
});
