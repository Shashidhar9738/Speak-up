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

test("login.html: the toggle keeps its icon element across toggles", async () => {
  const window = await loadPage("login.html");
  const input = window.document.getElementById("password");
  const toggle = input.parentNode.querySelector(".pwd-toggle");

  const iconBefore = toggle.querySelector("i");
  assert.ok(iconBefore, "toggle has no icon");

  toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  const iconRevealed = toggle.querySelector("i");
  assert.ok(iconRevealed, "icon vanished after revealing");
  assert.equal(iconRevealed, iconBefore, "icon element was replaced instead of restyled");
  assert.match(iconRevealed.className, /eye-off/);

  toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.match(toggle.querySelector("i").className, /ti-eye$/, "icon did not return to the closed eye");
});

test("login.html: the wrapper fills its row so the field cannot collapse", async () => {
  const window = await loadPage("login.html");
  const wrap = window.document.querySelector(".pwd-wrap");
  const styles = [...window.document.querySelectorAll("style")].map((n) => n.textContent).join(" ");
  assert.match(styles, /\.pwd-wrap\s*\{[^}]*display:\s*block/,
    "an inline wrapper collapses the input it contains");
  assert.ok(wrap, "no password wrapper found");
});

test("login.html: pressing the toggle does not blur the input away", async () => {
  const window = await loadPage("login.html");
  const input = window.document.getElementById("password");
  const toggle = input.parentNode.querySelector(".pwd-toggle");

  const event = new window.Event("mousedown", { bubbles: true, cancelable: true });
  toggle.dispatchEvent(event);
  assert.ok(event.defaultPrevented,
    "mousedown was not prevented, so focus leaves the field and the blur handler fights the click");
});

test("login.html: a revealed password re-hides on blur", async () => {
  const window = await loadPage("login.html");
  const input = window.document.getElementById("password");
  const toggle = input.parentNode.querySelector(".pwd-toggle");

  toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(input.type, "text");
  input.dispatchEvent(new window.Event("blur"));
  // The re-hide is deferred by a tick so focus moving to the toggle itself
  // does not count as leaving the field.
  await new Promise((r) => setTimeout(r, 20));
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

/* ---------------- role-specific interfaces ---------------- */

function scopeFor(role, extra = {}) {
  const caps = {
    owner:    { canManageUsers: true,  canExport: true,  canRespond: true,  seesRawText: true },
    reviewer: { canManageUsers: false, canExport: true,  canRespond: true,  seesRawText: true },
    lead:     { canManageUsers: false, canExport: false, canRespond: true,  seesRawText: true },
    staff:    { canManageUsers: false, canExport: false, canRespond: false, seesRawText: true },
    analyst:  { canManageUsers: false, canExport: false, canRespond: false, seesRawText: false }
  }[role];
  return { role, roleLabel: role, departments: "all", seesSensitive: role === "owner" || role === "reviewer", ...caps, ...extra };
}

async function dashboardAs(role) {
  return loadPage("index.html", {
    api: {
      isSignedIn: () => true,
      me: async () => ({ user: { email: `${role}@comviva.com`, role }, scope: scopeFor(role) })
    }
  });
}

function visibleTabs(window) {
  return [...window.document.querySelectorAll(".tab[data-tab]")]
    .filter((tab) => tab.style.display !== "none")
    .map((tab) => tab.dataset.tab);
}

test("staff does not get the leadership action queue", async () => {
  const window = await dashboardAs("staff");
  const tabs = visibleTabs(window);
  assert.ok(!tabs.includes("critical"),
    "staff can see Critical issues, an action queue they cannot act on");
  assert.ok(tabs.includes("overview"), "staff lost the overview");
});

test("owner keeps every tab", async () => {
  const window = await dashboardAs("owner");
  const tabs = visibleTabs(window);
  for (const expected of ["overview", "critical", "feed", "recognition", "trends"]) {
    assert.ok(tabs.includes(expected), `owner is missing ${expected}`);
  }
});

test("staff and owner do not see the same interface", async () => {
  const staff = visibleTabs(await dashboardAs("staff"));
  const owner = visibleTabs(await dashboardAs("owner"));
  assert.notDeepEqual(staff, owner, "staff and owner are shown an identical dashboard");
  assert.ok(staff.length < owner.length, "staff sees as much as an owner");
});

test("staff gets the calm band, not the executive briefing", async () => {
  const window = await dashboardAs("staff");
  const host = window.document.getElementById("execSummary");
  assert.ok(host.querySelector(".staff-band"), "staff did not get the staff band");
  assert.equal(host.querySelector(".exec"), null,
    "staff was shown the leadership briefing");
});

test("owner gets the executive briefing", async () => {
  const window = await dashboardAs("owner");
  const host = window.document.getElementById("execSummary");
  assert.ok(host.querySelector(".exec"), "owner lost the executive briefing");
});

test("analyst, who cannot read report text, loses the feed", async () => {
  const window = await dashboardAs("analyst");
  const tabs = visibleTabs(window);
  assert.ok(!tabs.includes("feed"), "analyst can open a feed of text they cannot read");
  assert.ok(!tabs.includes("critical"));
});

/* ---------------- search and date filtering ---------------- */

async function dashboardWithCapture() {
  const calls = [];
  const window = await loadPage("index.html", {
    api: {
      isSignedIn: () => true,
      me: async () => ({ user: { email: "o@comviva.com", role: "owner" }, scope: scopeFor("owner") }),
      dashboard: {
        submissions: async (query) => {
          calls.push(query || {});
          return { count: 0, submissions: [], filters: query || {} };
        }
      }
    }
  });
  return { window, calls };
}

test("typing a search sends it to the API", async () => {
  const { window, calls } = await dashboardWithCapture();
  const before = calls.length;

  const input = window.document.getElementById("searchInput");
  input.value = "weekend manager";
  input.dispatchEvent(new window.Event("keydown", { bubbles: true }));
  // Enter bypasses the debounce.
  const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  await new Promise((r) => setTimeout(r, 80));

  const withSearch = calls.slice(before).filter((c) => c.search === "weekend manager");
  assert.ok(withSearch.length > 0, "search term never reached the API");
});

test("clearing the search removes the filter", async () => {
  const { window, calls } = await dashboardWithCapture();
  const input = window.document.getElementById("searchInput");

  input.value = "harassment";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 80));

  window.document.getElementById("searchClear").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  const last = calls[calls.length - 1];
  assert.equal(last.search, undefined, "search filter survived being cleared");
});

test("the date range actually filters instead of just reloading", async () => {
  const { window, calls } = await dashboardWithCapture();
  const select = window.document.getElementById("dateRange");

  select.value = "7";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  const last = calls[calls.length - 1];
  assert.equal(last.days, "7", "date range did not reach the API");
});

test("custom range only filters once both dates are set", async () => {
  const { window, calls } = await dashboardWithCapture();
  const select = window.document.getElementById("dateRange");

  select.value = "custom";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(window.document.getElementById("customRange").classList.contains("show"),
    "custom date inputs stayed hidden");

  const countAfterCustom = calls.length;
  const from = window.document.getElementById("dateFrom");
  from.value = "2026-07-01";
  from.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, countAfterCustom, "filtered on a half-entered range");

  const to = window.document.getElementById("dateTo");
  to.value = "2026-07-31";
  to.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  const last = calls[calls.length - 1];
  assert.equal(last.from, "2026-07-01");
  assert.equal(last.to, "2026-07-31");
});

test("a filtered view says so, so it is not mistaken for a quiet week", async () => {
  const window = await loadPage("index.html", {
    api: {
      isSignedIn: () => true,
      me: async () => ({ user: { email: "o@comviva.com", role: "owner" }, scope: scopeFor("owner") }),
      dashboard: {
        submissions: async () => ({ count: 0, submissions: [], filters: { search: "zzz", days: "7" } })
      }
    }
  });
  await new Promise((r) => setTimeout(r, 60));

  const note = window.document.getElementById("resultNote").textContent;
  assert.match(note, /zzz/, "the note does not say what was searched for");
  assert.match(note, /nothing matches/i, "an empty result gave no explanation");
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
