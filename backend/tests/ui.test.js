/**
 * Frontend tests.
 *
 * The API suite could not see the bug that shipped three times: every page
 * linked to "Sign in" whether or not a session existed. Correct API, correct
 * HTML, wrong thing on screen. These tests load each page in jsdom with a
 * stubbed API and assert what the user actually ends up looking at.
 *
 * Run with: npm run test:ui
 */
const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");

/**
 * Load a page with a fake backend. `api` overrides individual SpeakUpApi
 * methods; everything else resolves empty so a page never hangs on a missing
 * stub and fails for the wrong reason.
 */
async function loadPage(page, options = {}) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost:3000/" + page
  });
  const { window } = dom;

  window.fetch = async () => ({ ok: false, status: 404, text: async () => "", json: async () => ({}) });
  window.alert = () => {};
  window.Chart = function () { return { destroy() {} }; };
  window.Chart.defaults = { font: {}, plugins: { tooltip: {} } };

  const base = {
    isSignedIn: () => false,
    getEmail: () => "",
    getToken: () => "",
    setSession: () => {},
    clearSession: () => {},
    me: async () => { throw Object.assign(new Error("Not signed in"), { status: 401 }); },
    login: async () => ({ token: "t", email: "x@comviva.com", role: "owner" }),
    logout: async () => {},
    register: async () => ({ status: "pending_verification" }),
    verifyRegistration: async () => ({ status: "approved" }),
    submit: async () => ({ submission: { id: "TKT-TEST-0001", keywords: [] }, accessCode: "SPK-TEST-CODE" }),
    track: async () => ({ submission: {}, messages: [], canEdit: false }),
    appreciationCategories: async () => ({ categories: [] }),
    appreciate: async () => ({ appreciation: { id: "KUD-TEST-0001" }, accessCode: "KDS-TEST-CODE" }),
    revealNominator: async () => ({ appreciation: {} }),
    priorityTiers: async () => ({ tiers: [] }),
    appreciationDashboard: async () => ({ metrics: {}, categories: [], appreciations: [] }),
    dashboard: {
      metrics: async () => ({ metrics: { totals: {}, statusCounts: {}, sentimentCounts: {}, categoryCounts: {}, topKeywords: [], weeklyTrend: [], departmentHeatmap: {}, priorityIssues: [], latestSubmissions: [] } }),
      submissions: async () => ({ count: 0, submissions: [] }),
      alerts: async () => ({ alerts: [] }),
      categories: async () => ({ categories: [] }),
      trends: async () => ({ trends: [] }),
      heatmap: async () => ({ heatmap: {} }),
      exportCsv: async () => new window.Blob([""])
    },
    admin: { users: async () => ({ users: [] }), decide: async () => ({}) }
  };

  window.SpeakUpApi = { ...base, ...(options.api || {}) };
  if (options.api && options.api.dashboard) {
    window.SpeakUpApi.dashboard = { ...base.dashboard, ...options.api.dashboard };
  }
  // Pages await this before booting; resolve it so demo mode never installs.
  window.SPEAKUP_DEMO_READY = Promise.resolve(false);

  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const code of scripts) {
    try {
      window.eval(code);
    } catch (error) {
      if (!/Chart|canvas|getContext/i.test(String(error.message))) { throw error; }
    }
  }

  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Pages set intervals (the dashboard auto-refreshes). Left running, they keep
  // the test process alive forever.
  openWindows.push(window);
  return window;
}

// Closed after every test so timers cannot outlive the assertion.
const openWindows = [];
afterEach(() => {
  while (openWindows.length) {
    try { openWindows.pop().close(); } catch (error) { /* already closed */ }
  }
});

/* ---------------- the bug that shipped three times ---------------- */

for (const page of ["submit.html", "track.html", "appreciation.html"]) {
  test(`${page}: offers Sign in when signed out`, async () => {
    const window = await loadPage(page);
    const text = window.document.getElementById("leadershipText");
    assert.ok(text, "leadershipText element is missing");
    assert.equal(text.textContent.trim(), "Sign in");
  });

  test(`${page}: offers Dashboard when already signed in`, async () => {
    const window = await loadPage(page, {
      api: {
        isSignedIn: () => true,
        me: async () => ({ user: { email: "a@comviva.com", role: "owner" }, scope: {} })
      }
    });
    const link = window.document.getElementById("leadershipLink");
    const text = window.document.getElementById("leadershipText");
    assert.equal(text.textContent.trim(), "Dashboard", "still says Sign in to a signed-in user");
    assert.ok(link.getAttribute("href").includes("index.html"));
  });
}

test("register.html: tells a signed-in user they are already signed in", async () => {
  const window = await loadPage("register.html", {
    api: {
      isSignedIn: () => true,
      me: async () => ({ user: { email: "a@comviva.com", role: "owner" }, scope: {} })
    }
  });
  const note = window.document.getElementById("sessionNote");
  assert.match(note.textContent, /already signed in/i);
});

/* ---------------- password handling ---------------- */

for (const page of ["login.html", "register.html"]) {
  test(`${page}: every password field has a reveal toggle`, async () => {
    const window = await loadPage(page);
    const inputs = window.document.querySelectorAll("input[type=password]");
    assert.ok(inputs.length > 0, "no password fields found");
    const toggles = window.document.querySelectorAll(".pwd-toggle");
    assert.equal(toggles.length, inputs.length, "a password field has no reveal toggle");
  });
}

test("login.html: reveal toggle switches the field type and back", async () => {
  const window = await loadPage("login.html");
  const input = window.document.getElementById("password");
  const toggle = input.parentNode.querySelector(".pwd-toggle");

  assert.equal(input.type, "password");
  toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(input.type, "text", "toggle did not reveal");
  toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(input.type, "password", "toggle did not re-hide");
});

test("login.html: a revealed password re-hides on blur", async () => {
  const window = await loadPage("login.html");
  const input = window.document.getElementById("password");
  const toggle = input.parentNode.querySelector(".pwd-toggle");

  toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(input.type, "text");
  input.dispatchEvent(new window.Event("blur"));
  assert.equal(input.type, "password", "password left visible after losing focus");
});

test("login.html: sign-in requires a password", async () => {
  let called = false;
  const window = await loadPage("login.html", {
    api: { login: async () => { called = true; return { token: "t" }; } }
  });

  window.document.getElementById("email").value = "a@comviva.com";
  window.document.getElementById("password").value = "";
  window.document.getElementById("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(called, false, "submitted with an empty password");
});

/* ---------------- dashboard scope reflection ---------------- */

test("index.html: hides admin controls a role cannot use", async () => {
  const window = await loadPage("index.html", {
    api: {
      isSignedIn: () => true,
      me: async () => ({
        user: { email: "staff@comviva.com", role: "staff" },
        scope: { roleLabel: "Staff", departments: "all", canManageUsers: false, canExport: false, canRespond: false }
      })
    }
  });

  assert.equal(window.document.getElementById("usersBtn").style.display, "none",
    "account management shown to a non-owner");
  assert.equal(window.document.getElementById("exportBtn").style.display, "none",
    "export shown to a role that cannot export");
});

test("index.html: shows admin controls to an owner", async () => {
  const window = await loadPage("index.html", {
    api: {
      isSignedIn: () => true,
      me: async () => ({
        user: { email: "owner@comviva.com", role: "owner" },
        scope: { roleLabel: "Owner (CXO)", departments: "all", canManageUsers: true, canExport: true, canRespond: true }
      })
    }
  });

  assert.notEqual(window.document.getElementById("usersBtn").style.display, "none");
  assert.notEqual(window.document.getElementById("exportBtn").style.display, "none");
});

/* ---------------- escaping ---------------- */

test("index.html: complaint text is escaped, not injected", async () => {
  const hostile = '<img src=x onerror="window.__pwned=1">';
  const window = await loadPage("index.html", {
    api: {
      isSignedIn: () => true,
      me: async () => ({
        user: { email: "o@comviva.com", role: "owner" },
        scope: { roleLabel: "Owner", departments: "all", canManageUsers: true, canExport: true, canRespond: true }
      }),
      dashboard: {
        submissions: async () => ({
          count: 1,
          submissions: [{
            id: "TKT-XSS-0001", messageText: hostile, summary: hostile,
            category: "General", department: "Engineering", status: "open",
            priority: "P3", priorityScore: 20, sentiment: "neutral",
            keywords: [], createdAt: new Date().toISOString(), flags: {}
          }]
        })
      }
    }
  });

  await new Promise((r) => setTimeout(r, 60));
  assert.notEqual(window.__pwned, 1, "submission text executed as HTML");
  assert.equal(window.document.querySelectorAll('img[src="x"]').length, 0,
    "hostile markup made it into the DOM");
});
