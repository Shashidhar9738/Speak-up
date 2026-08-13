/**
 * Demo mode.
 *
 * GitHub Pages serves static files only — there is no backend, so every API
 * call 404s and the dashboard renders nothing. This file intercepts
 * SpeakUpApi when no backend is reachable and answers from sample data held
 * in memory, so the UI can be shown and shared as a link.
 *
 * It is a presentation shim, not a fake product:
 *   - a banner states plainly that the data is not real
 *   - anything that would persist reports "demo mode" rather than pretending
 *   - it activates ONLY when the API is genuinely unreachable, so a real
 *     deployment is never silently replaced by sample data
 */
(function (global) {
  "use strict";

  var DEPARTMENTS = ["Engineering", "Product", "Sales", "People & HR", "Finance", "Marketing", "Legal", "Operations", "Support"];

  // Written to exercise every branch of the UI: each priority, each status,
  // every category, sensitive and non-sensitive, positive and negative.
  var SEED = [
    ["A senior colleague made repeated hostile comments in front of the team and I am afraid of retaliation if I name them.", "Harassment & Ethics", "Sales", "open", 2],
    ["My manager threatened a poor review after I raised concerns about how overtime is allocated.", "Harassment & Ethics", "Engineering", "acknowledged", 9],
    ["A confidential customer data leak has not been escalated for three weeks. This is urgent.", "Security & Compliance", "Legal", "open", 4],
    ["Three people resigned from my team this quarter and there is still no plan to backfill. The rest of us are burnt out.", "Workload", "Engineering", "open", 6],
    ["Forced to work every weekend this month on the release with no compensatory time off.", "Workload", "Product", "acknowledged", 12],
    ["My reimbursement of forty thousand rupees has been pending with payroll for four months despite six follow ups.", "Payroll & Benefits", "Finance", "open", 8],
    ["No salary adjustment in eighteen months despite consistently strong performance reviews.", "Payroll & Benefits", "Marketing", "resolved", 21],
    ["Bonus calculations seem arbitrary. Two people with identical ratings received very different amounts.", "Payroll & Benefits", "Sales", "resolved", 26],
    ["Team leads play favourites. Promotions go to people who socialise with leadership, not to performers.", "Management", "Operations", "open", 5],
    ["Micromanagement has become unbearable. Every small decision needs three separate approvals.", "Management", "Support", "acknowledged", 14],
    ["No feedback at all during my entire probation, then a poor rating at the end of it.", "Management", "People & HR", "resolved", 30],
    ["The air conditioning in Building C has been broken for three weeks. Temperatures are unbearable.", "Facilities & IT", "Operations", "resolved", 18],
    ["My laptop crashes daily and IT support has not responded to my ticket in two weeks.", "Facilities & IT", "Engineering", "open", 3],
    ["The new flexible hours policy has been genuinely helpful for my commute and family life. Thank you.", "General", "Product", "resolved", 16],
    ["The mentorship programme is excellent — my mentor helped me get promoted this cycle.", "General", "People & HR", "resolved", 24]
  ];

  var PRIORITY = {
    "Harassment & Ethics": ["P1", "Critical — act immediately", "#dc2626", "24 hours", 92],
    "Security & Compliance": ["P1", "Critical — act immediately", "#dc2626", "24 hours", 96],
    "Workload": ["P2", "High — act this week", "#d97706", "5 working days", 71],
    "Payroll & Benefits": ["P2", "High — act this week", "#d97706", "5 working days", 67],
    "Management": ["P3", "Normal — schedule it", "#2a78d6", "30 days", 38],
    "Facilities & IT": ["P3", "Normal — schedule it", "#2a78d6", "30 days", 31],
    "General": ["P3", "Normal — schedule it", "#2a78d6", "30 days", 25]
  };

  var REASON = {
    P1: "Matched P1 keyword: retaliation",
    P2: "Matched P2 keywords: resigned, pending",
    P3: "No priority keywords matched"
  };

  var STOP = new Set(["the", "and", "for", "that", "with", "this", "from", "have", "has", "been", "there", "their", "they", "them", "about", "after", "still", "would", "could", "every", "three", "four", "were", "what", "when", "your", "into", "than", "then", "more", "most", "some", "only", "also", "over", "very", "just", "with"]);

  function id() {
    var a = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", s = "";
    for (var i = 0; i < 8; i += 1) { s += a[Math.floor(Math.random() * a.length)]; }
    return "TKT-" + s.slice(0, 4) + "-" + s.slice(4);
  }

  function keywords(text) {
    var words = (text.toLowerCase().match(/[a-z]{4,}/g) || []).filter(function (w) { return !STOP.has(w); });
    var out = [];
    for (var i = 0; i < words.length - 1 && out.length < 4; i += 2) {
      out.push(words[i] + " " + words[i + 1]);
    }
    return out;
  }

  var submissions = SEED.map(function (row) {
    var text = row[0], category = row[1], dept = row[2], status = row[3], daysAgo = row[4];
    var p = PRIORITY[category];
    var created = new Date(Date.now() - daysAgo * 86400000);
    var updated = status === "open" ? created : new Date(created.getTime() + 2 * 86400000);
    return {
      id: id(),
      messageText: text,
      summary: text.length > 160 ? text.slice(0, 157) + "..." : text,
      category: category,
      department: dept,
      region: "India",
      channel: "web",
      status: status,
      sentiment: category === "General" ? "positive" : "negative",
      priority: p[0], priorityLabel: p[1], priorityColour: p[2], sla: p[3],
      priorityScore: p[4], priorityReason: REASON[p[0]],
      keywords: keywords(text),
      flags: { spam: false, urgent: p[0] === "P1", sensitive: category === "Harassment & Ethics" || category === "Security & Compliance" },
      quarantined: false,
      createdAt: created.toISOString(),
      updatedAt: updated.toISOString(),
      messages: []
    };
  });

  function isoWeek(iso) {
    var d = new Date(iso);
    var day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var n = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() + 4 - n);
    var start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    return day.getUTCFullYear() + "-W" + String(Math.ceil((((day - start) / 86400000) + 1) / 7)).padStart(2, "0");
  }

  function buildMetrics(list) {
    var statusCounts = { open: 0, acknowledged: 0, resolved: 0 };
    var sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    var categoryCounts = {}, keywordCounts = {}, heatmap = {}, trend = {};

    list.forEach(function (s) {
      var week = isoWeek(s.createdAt);
      statusCounts[s.status] += 1;
      sentimentCounts[s.sentiment] += 1;
      categoryCounts[s.category] = (categoryCounts[s.category] || 0) + 1;
      trend[week] = (trend[week] || 0) + 1;
      heatmap[s.department] = heatmap[s.department] || {};
      heatmap[s.department][week] = (heatmap[s.department][week] || 0) + 1;
      (s.keywords || []).forEach(function (k) { keywordCounts[k] = (keywordCounts[k] || 0) + 1; });
    });

    var sorted = list.slice().sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

    return {
      totals: {
        submissions: list.length,
        open: statusCounts.open,
        acknowledged: statusCounts.acknowledged,
        resolved: statusCounts.resolved
      },
      statusCounts: statusCounts,
      sentimentCounts: sentimentCounts,
      categoryCounts: categoryCounts,
      topKeywords: Object.entries(keywordCounts)
        .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); })
        .slice(0, 12).map(function (e) { return { keyword: e[0], count: e[1] }; }),
      weeklyTrend: Object.entries(trend).sort(function (a, b) { return a[0].localeCompare(b[0]); })
        .map(function (e) { return { week: e[0], count: e[1] }; }),
      departmentHeatmap: heatmap,
      priorityIssues: sorted.filter(function (s) { return s.status !== "resolved"; }).slice(0, 8),
      latestSubmissions: sorted.slice(0, 10)
    };
  }

  var ORDER = { P1: 0, P2: 1, P3: 2 };
  function byPriority(a, b) {
    var t = ORDER[a.priority] - ORDER[b.priority];
    if (t) { return t; }
    return b.priorityScore - a.priorityScore || new Date(b.createdAt) - new Date(a.createdAt);
  }

  function filtered(query) {
    var q = query || {};
    return submissions.filter(function (s) {
      if (q.status && s.status !== q.status) { return false; }
      if (q.category && s.category !== q.category) { return false; }
      if (q.sentiment && s.sentiment !== q.sentiment) { return false; }
      if (q.department && s.department !== q.department) { return false; }
      if (q.priority && s.priority !== q.priority) { return false; }
      return true;
    });
  }

  function later(value) {
    // A small delay so loading states are visible rather than flashing.
    return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, 120); });
  }

  function unavailable(what) {
    var error = new Error(what + " is unavailable in the demo — it needs the backend.");
    error.status = 501;
    return Promise.reject(error);
  }

  function banner() {
    if (document.getElementById("demoBanner")) { return; }
    var bar = document.createElement("div");
    bar.id = "demoBanner";
    bar.style.cssText = [
      "position:fixed", "left:0", "right:0", "bottom:0", "z-index:9999",
      "background:#14162a", "color:#e9ecf5", "font:500 12.5px/1.5 Inter,-apple-system,sans-serif",
      "padding:9px 18px", "text-align:center", "border-top:1px solid rgba(255,255,255,.12)"
    ].join(";");
    bar.innerHTML =
      '<strong style="color:#ffbb54;">Demo</strong> &nbsp;Sample data, no backend. ' +
      'Nothing is saved and no real reports exist here. ' +
      '<a href="https://github.com/Shashidhar9738/Speak-up" style="color:#9db4ff;">Source</a>';
    document.body.appendChild(bar);
    document.body.style.paddingBottom = "40px";
  }

  function install() {
    var api = global.SpeakUpApi;
    if (!api) { return; }

    global.SPEAKUP_DEMO = true;

    api.isSignedIn = function () { return true; };
    api.getEmail = function () { return "demo@speakup.local"; };
    api.login = function (email) { return later({ token: "demo", email: email || "demo@speakup.local", role: "owner" }); };
    api.logout = function () { return later(null); };
    api.me = function () {
      return later({
        user: { email: "demo@speakup.local", role: "owner" },
        scope: {
          role: "owner", roleLabel: "Owner (CXO) — demo", departments: "all",
          seesSensitive: true, seesRawText: true,
          canManageUsers: false, canExport: false, canRespond: false
        }
      });
    };

    api.priorityTiers = function () {
      return later({ tiers: [
        { priority: "P1", label: "Critical — act immediately", colour: "#dc2626", colourLight: "#fdeeee", sla: "24 hours", keywords: [] },
        { priority: "P2", label: "High — act this week", colour: "#d97706", colourLight: "#fef6e7", sla: "5 working days", keywords: [] },
        { priority: "P3", label: "Normal — schedule it", colour: "#2a78d6", colourLight: "#dbeafe", sla: "30 days", keywords: [] }
      ] });
    };

    api.dashboard = {
      metrics: function (q) { return later({ metrics: buildMetrics(filtered(q)), scope: { roleLabel: "Owner (CXO) — demo", departments: "all", canManageUsers: false, canExport: false, canRespond: false } }); },
      submissions: function (q) {
        var list = filtered(q).sort((q && q.sort === "recent")
          ? function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); }
          : byPriority);
        return later({ count: list.length, limit: 200, sort: (q && q.sort) || "priority", submissions: list });
      },
      categories: function (q) {
        var counts = buildMetrics(filtered(q)).categoryCounts;
        return later({ categories: Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; })
          .map(function (e) { return { category: e[0], count: e[1] }; }) });
      },
      trends: function (q) { return later({ trends: buildMetrics(filtered(q)).weeklyTrend }); },
      heatmap: function (q) { return later({ heatmap: buildMetrics(filtered(q)).departmentHeatmap }); },
      alerts: function (q) {
        return later({ alerts: filtered(q)
          .filter(function (s) { return s.priority === "P1" || s.flags.urgent || s.flags.sensitive; })
          .sort(byPriority) });
      },
      exportCsv: function () { return unavailable("CSV export"); }
    };

    api.submit = function (payload) {
      // Accepted and shown back, but explicitly not persisted — a demo that
      // silently discarded a real complaint would be worse than one that says so.
      var text = (payload && payload.messageText) || "";
      return later({
        submission: {
          id: id(), messageText: text,
          summary: text.slice(0, 160),
          category: "Workload", priority: "P2", sentiment: "negative",
          keywords: keywords(text), demo: true
        },
        accessCode: "SPK-DEMO0-DEMO0"
      });
    };

    api.track = function () { return unavailable("Report tracking"); };
    api.trackReply = function () { return unavailable("Replying"); };
    api.trackEdit = function () { return unavailable("Editing"); };
    api.setStatus = function () { return unavailable("Changing status"); };
    api.postMessage = function () { return unavailable("Messaging"); };
    api.getSubmission = function (sid) {
      var found = submissions.find(function (s) { return s.id === sid; });
      return found ? later({ submission: found }) : unavailable("That report");
    };
    api.getMessages = function () { return later({ messages: [] }); };
    api.admin = {
      users: function () { return unavailable("Account management"); },
      decide: function () { return unavailable("Account management"); }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", banner);
    } else {
      banner();
    }
  }

  /**
   * Probe for a real backend. Demo data must never mask a live deployment, so
   * this only installs when /api/health is genuinely unreachable.
   */
  var probe = fetch("api/health", { method: "GET" })
    .then(function (r) { return r.ok; })
    .catch(function () { return false; });

  global.SPEAKUP_DEMO_READY = probe.then(function (live) {
    if (!live) { install(); }
    return !live;
  });
})(window);
