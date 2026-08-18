/**
 * SpeakUp API client.
 *
 * Shared by submit.html (anonymous, no token) and login.html / index.html
 * (admin, bearer token). Kept dependency-free so every page can load it with a
 * plain <script> tag.
 */
(function (global) {
  "use strict";

  var TOKEN_KEY = "speakup.admin.token";
  var EMAIL_KEY = "speakup.admin.email";

  // Same-origin by default; override with <script>window.SPEAKUP_API_BASE="..."</script>
  // when the dashboard is served from a different host than the API.
  function baseUrl() {
    return (global.SPEAKUP_API_BASE || "").replace(/\/$/, "");
  }

  function getToken() {
    try {
      return global.localStorage.getItem(TOKEN_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function setSession(token, email) {
    try {
      global.localStorage.setItem(TOKEN_KEY, token);
      global.localStorage.setItem(EMAIL_KEY, email || "");
    } catch (error) {
      /* storage disabled — session stays in-memory for this page only */
    }
  }

  function getEmail() {
    try {
      return global.localStorage.getItem(EMAIL_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function clearSession() {
    try {
      global.localStorage.removeItem(TOKEN_KEY);
      global.localStorage.removeItem(EMAIL_KEY);
    } catch (error) {
      /* nothing to clear */
    }
  }

  function ApiError(message, status) {
    var error = new Error(message);
    error.name = "ApiError";
    error.status = status;
    return error;
  }

  // True only when the server says the session or the account itself is the
  // problem — a token that is expired, malformed or signed wrong, or an account
  // that has been revoked or is still awaiting approval. requireAdmin attaches
  // details.reason to exactly those; nothing else in the API does.
  function isSessionFailure(status, payload) {
    if (status !== 401 && status !== 403) {
      return false;
    }
    return Boolean(payload && payload.details && payload.details.reason);
  }

  async function request(path, options) {
    var settings = options || {};
    var headers = { Accept: "application/json" };

    if (settings.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (settings.auth) {
      var token = getToken();
      if (!token) {
        throw ApiError("Not signed in", 401);
      }
      headers.Authorization = "Bearer " + token;
    }

    var response;
    try {
      response = await fetch(baseUrl() + path, {
        method: settings.method || "GET",
        headers: headers,
        body: settings.body === undefined ? undefined : JSON.stringify(settings.body)
      });
    } catch (networkError) {
      throw ApiError("Cannot reach the SpeakUp API. Is the server running?", 0);
    }

    if (response.status === 204) {
      return null;
    }

    var payload = null;
    var text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (parseError) {
        payload = null;
      }
    }

    // An expired or revoked token should drop the admin back to the login page
    // rather than leaving a half-rendered dashboard behind. Status alone cannot
    // tell us that: most 401s and 403s here are ordinary refusals with a working
    // session — "Your role cannot export complaint data", or a mistyped current
    // password — and signing the admin out of those loses their place and blames
    // an expiry that never happened. Only the auth middleware tags a failure
    // with details.reason, so that marker, not the status, is what logs us out.
    if (settings.auth && isSessionFailure(response.status, payload)) {
      clearSession();
      if (settings.redirectOnAuthFailure !== false) {
        global.location.href = "login.html?expired=1";
      }
      throw ApiError("Session expired. Please sign in again.", response.status);
    }

    if (!response.ok) {
      var message = (payload && (payload.error || payload.reason)) || ("Request failed (" + response.status + ")");
      throw ApiError(message, response.status);
    }

    return payload;
  }

  var api = {
    TOKEN_KEY: TOKEN_KEY,
    getToken: getToken,
    getEmail: getEmail,
    setSession: setSession,
    clearSession: clearSession,
    isSignedIn: function () {
      return Boolean(getToken());
    },

    health: function () {
      return request("/api/health");
    },

    login: async function (email, password) {
      var result = await request("/api/auth/login", {
        method: "POST",
        body: { email: email, password: password }
      });
      setSession(result.token, result.email);
      return result;
    },

    changePassword: function (currentPassword, newPassword) {
      return request("/api/auth/password", {
        method: "POST",
        auth: true,
        body: { currentPassword: currentPassword, newPassword: newPassword }
      });
    },

    me: function () {
      return request("/api/auth/me", { auth: true });
    },

    register: function (payload) {
      return request("/api/auth/register", { method: "POST", body: payload });
    },

    verifyRegistration: function (email, code) {
      return request("/api/auth/verify", { method: "POST", body: { email: email, code: code } });
    },

    registrationStatus: function (email) {
      return request("/api/auth/registration-status?email=" + encodeURIComponent(email));
    },

    // Action plans: what was decided about a pattern, and whether it worked.
    actionPlans: {
      list: function () { return request("/api/action-plans", { auth: true }); },
      create: function (payload) {
        return request("/api/action-plans", { method: "POST", auth: true, body: payload });
      },
      update: function (id, changes) {
        return request("/api/action-plans/" + encodeURIComponent(id), {
          method: "POST", auth: true, body: changes
        });
      }
    },

    admin: {
      users: function () {
        return request("/api/admin/users", { auth: true });
      },
      decide: function (email, decision, role, departments) {
        return request("/api/admin/users/" + encodeURIComponent(email) + "/decision", {
          method: "POST",
          auth: true,
          body: { decision: decision, role: role, departments: departments }
        });
      }
    },

    logout: async function () {
      try {
        await request("/api/auth/logout", { method: "POST" });
      } catch (error) {
        /* logout is best-effort; the local session is cleared regardless */
      }
      clearSession();
    },

    submit: function (payload) {
      return request("/api/submissions", { method: "POST", body: payload });
    },

    // Appreciation — open like a report, but the recipient is named and the
    // nominator stays anonymous unless they later opt in.
    appreciationCategories: function () {
      return request("/api/appreciations/categories");
    },

    appreciate: function (payload) {
      return request("/api/appreciations", { method: "POST", body: payload });
    },

    appreciationDashboard: function (query) {
      return request("/api/dashboard/appreciation" + toQueryString(query), { auth: true });
    },

    suggestedReplies: function (id) {
      return request("/api/appreciations/" + encodeURIComponent(id) + "/suggested-replies", { auth: true });
    },

    acknowledgeAppreciation: function (id) {
      return request("/api/appreciations/" + encodeURIComponent(id) + "/acknowledge", { method: "POST", auth: true });
    },

    // Returned as a Blob so the caller can open it in a tab; the digest is
    // email-ready HTML rather than JSON meant for rendering.
    brightSpotsHtml: async function (days) {
      var response = await fetch(baseUrl() + "/api/export/brightspots?format=html&days=" + (days || 7), {
        headers: { Authorization: "Bearer " + getToken() }
      });
      if (!response.ok) {
        throw ApiError("Digest failed (" + response.status + ")", response.status);
      }
      return new Blob([await response.text()], { type: "text/html" });
    },

    setSpotlight: function (id, on) {
      return request("/api/admin/spotlights/" + encodeURIComponent(id), {
        method: "POST", auth: true, body: { spotlight: on !== false }
      });
    },

    // Reporter-side: authenticated by access code only, never a bearer token.
    track: function (id, accessCode) {
      return request("/api/track/" + encodeURIComponent(id), {
        method: "POST",
        body: { accessCode: accessCode }
      });
    },

    trackEdit: function (id, accessCode, messageText) {
      return request("/api/track/" + encodeURIComponent(id) + "/edit", {
        method: "POST",
        body: { accessCode: accessCode, messageText: messageText }
      });
    },

    priorityTiers: function () {
      return request("/api/priority-tiers");
    },

    trackReply: function (id, accessCode, messageText) {
      return request("/api/track/" + encodeURIComponent(id) + "/messages", {
        method: "POST",
        body: { accessCode: accessCode, messageText: messageText }
      });
    },

    getSubmission: function (id) {
      return request("/api/submissions/" + encodeURIComponent(id), { auth: true });
    },

    setStatus: function (id, status, note) {
      return request("/api/submissions/" + encodeURIComponent(id) + "/status", {
        method: "POST",
        auth: true,
        body: { status: status, note: note }
      });
    },

    getMessages: function (id) {
      return request("/api/submissions/" + encodeURIComponent(id) + "/messages", { auth: true });
    },

    postMessage: function (id, messageText, authorType) {
      return request("/api/submissions/" + encodeURIComponent(id) + "/messages", {
        method: "POST",
        auth: true,
        body: { messageText: messageText, authorType: authorType || "admin" }
      });
    },

    dashboard: {
      submissions: function (query) {
        return request("/api/dashboard/submissions" + toQueryString(query), { auth: true });
      },
      metrics: function (query) {
        return request("/api/dashboard/metrics" + toQueryString(query), { auth: true });
      },
      categories: function (query) {
        return request("/api/dashboard/categories" + toQueryString(query), { auth: true });
      },
      trends: function (query) {
        return request("/api/dashboard/trends" + toQueryString(query), { auth: true });
      },
      heatmap: function (query) {
        return request("/api/dashboard/heatmap" + toQueryString(query), { auth: true });
      },
      insights: function (query) {
        return request("/api/dashboard/insights" + toQueryString(query), { auth: true });
      },
      timeline: function (id) {
        return request("/api/submissions/" + encodeURIComponent(id) + "/timeline", { auth: true });
      },
      // Duplicates are linked, not combined: each reporter keeps their own
      // thread, so this only records the relationship.
      merge: function (id, into) {
        return request("/api/submissions/" + encodeURIComponent(id) + "/merge", {
          method: "POST", auth: true,
          body: into === null ? { merge: false } : { into: into }
        });
      },
      related: function (id) {
        return request("/api/submissions/" + encodeURIComponent(id) + "/related", { auth: true });
      },
      assign: function (id, to, dueAt) {
        return request("/api/submissions/" + encodeURIComponent(id) + "/assign", {
          method: "POST", auth: true, body: { to: to, dueAt: dueAt }
        });
      },
      patterns: function (query) {
        return request("/api/dashboard/patterns" + toQueryString(query), { auth: true });
      },
      awaitingReply: function (query) {
        return request("/api/dashboard/awaiting-reply" + toQueryString(query), { auth: true });
      },
      alerts: function (query) {
        return request("/api/dashboard/alerts" + toQueryString(query), { auth: true });
      },
      // CSV must go through fetch (not a plain link) because the endpoint needs
      // the Authorization header, which an <a download> cannot set.
      exportCsv: async function (query) {
        var response = await fetch(baseUrl() + "/api/dashboard/export.csv" + toQueryString(query), {
          headers: { Authorization: "Bearer " + getToken() }
        });
        if (!response.ok) {
          throw ApiError("Export failed (" + response.status + ")", response.status);
        }
        return response.blob();
      }
    }
  };

  function toQueryString(query) {
    if (!query) {
      return "";
    }
    var parts = [];
    Object.keys(query).forEach(function (key) {
      var value = query[key];
      if (value === undefined || value === null || value === "") {
        return;
      }
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  api.toQueryString = toQueryString;
  global.SpeakUpApi = api;
})(window);
