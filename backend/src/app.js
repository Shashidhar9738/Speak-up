const crypto = require("crypto");
const path = require("path");
const express = require("express");
const config = require("./config");
const { requireAdmin } = require("./middleware/authMiddleware");
const { createRateLimiter } = require("./middleware/rateLimitMiddleware");
const {
  validateLoginRequest,
  validateSubmissionRequest,
  validateStatusUpdateRequest,
  validateMessageRequest
} = require("./middleware/validationMiddleware");
const { notFoundHandler, errorHandler, createHttpError } = require("./middleware/errorMiddleware");
const { createToken, verifyToken } = require("./services/tokenService");
const { listSubmissions, createSubmission, updateSubmission, getSubmissionById } = require("./services/storeService");
const { analyzeSubmission, buildMetrics, hashAccessCode } = require("./services/analysisService");
const { classifyPriority, comparePriority, publicTiers } = require("./services/priorityService");
const {
  registerUser,
  verifyUser,
  setUserStatus,
  listUsers,
  canSignIn,
  isAllowedDomain,
  isBootstrapOwner,
  setPassword,
  checkPassword,
  publicUser
} = require("./services/userService");
const { validatePassword, hashPassword, MIN_LENGTH } = require("./services/passwordService");
const appreciation = require("./services/appreciationService");
const audit = require("./services/auditService");
const notifications = require("./services/notificationService");
const mail = require("./services/mailService");
const webhooks = require("./services/webhookService");
const patterns = require("./services/patternService");
const {
  ROLE_LABELS,
  capabilitiesFor,
  canSeeSubmission,
  visibleSubmissions,
  redact,
  describeScope
} = require("./services/accessScopeService");

const VALID_STATUSES = new Set(["open", "acknowledged", "resolved"]);

function applyCors(request, response, next) {
  // An empty corsOrigin means same-origin only: send no ACAO header at all,
  // which is stricter than sending "*".
  if (config.corsOrigin) {
    response.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  return next();
}

/**
 * Resolves a date range from the query.
 *
 * Accepts either an explicit from/to (YYYY-MM-DD) or a relative window
 * (?days=30), which is what the dashboard's range picker sends. "to" is
 * pushed to the end of its day so a same-day from/to is not an empty range —
 * an easy way to make a filter look broken.
 */
function resolveDateRange(query) {
  const days = Number.parseInt(query.days, 10);
  if (Number.isFinite(days) && days > 0) {
    return { from: Date.now() - days * 86400000, to: Infinity, label: `last ${days} days` };
  }

  let from = -Infinity;
  let to = Infinity;

  if (query.from) {
    const parsed = Date.parse(String(query.from));
    if (!Number.isNaN(parsed)) { from = parsed; }
  }
  if (query.to) {
    const parsed = Date.parse(String(query.to));
    if (!Number.isNaN(parsed)) {
      to = /T/.test(String(query.to)) ? parsed : parsed + 86399999;
    }
  }

  return { from, to, label: null };
}

/**
 * Search across a submission's text, summary, category, department and ticket
 * id. Terms are AND-ed, so "sales weekend" finds reports mentioning both —
 * substring matching on the raw phrase would find neither unless they happened
 * to sit next to each other. A quoted "phrase" is matched literally.
 */
function matchesSearch(submission, rawQuery) {
  const haystack = [
    submission.messageText, submission.summary, submission.category,
    submission.department, submission.region, submission.id,
    (submission.keywords || []).join(" ")
  ].join(" ").toLowerCase();

  const query = String(rawQuery).toLowerCase().trim();
  const phrases = [];
  const remainder = query.replace(/"([^"]+)"/g, (_, phrase) => {
    phrases.push(phrase.trim());
    return " ";
  });

  for (const phrase of phrases) {
    if (phrase && !haystack.includes(phrase)) { return false; }
  }

  const terms = remainder.split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

function filterSubmissions(submissions, query) {
  // Spam is excluded from every dashboard, metric and export by default so it
  // cannot inflate counts or pollute the word cloud. ?includeSpam=true opts in
  // for a review queue.
  const includeSpam = String(query.includeSpam || "").toLowerCase() === "true";
  const range = resolveDateRange(query);

  return submissions.filter((submission) => {
    const isSpam = submission.quarantined === true || submission.flags?.spam === true;
    if (isSpam && !includeSpam) {
      return false;
    }

    const created = new Date(submission.createdAt).getTime();
    if (created < range.from || created > range.to) {
      return false;
    }

    if (query.status && submission.status !== query.status) {
      return false;
    }
    if (query.category && submission.category !== query.category) {
      return false;
    }
    if (query.sentiment && submission.sentiment !== query.sentiment) {
      return false;
    }
    if (query.department && submission.department !== query.department) {
      return false;
    }
    if (query.priority && submission.priority !== query.priority) {
      return false;
    }
    if (query.search && !matchesSearch(submission, query.search)) {
      return false;
    }
    return true;
  });
}


// Submission text is attacker-controlled and this export is opened in Excel by
// leadership, so a leading =, +, - or @ would be evaluated as a formula. Prefix
// those with an apostrophe to force them to render as text.
function escapeCsvValue(value) {
  const text = String(value ?? "");
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function toCsv(submissions) {
  const headers = ["id", "createdAt", "status", "priority", "sla", "priorityReason", "category", "sentiment", "department", "region", "channel", "summary"];
  const rows = submissions.map((submission) => headers.map((header) => escapeCsvValue(submission[header] || "")).join(","));
  return [headers.join(","), ...rows].join("\n");
}

// Number("abc") is NaN, and slice(0, NaN) returns nothing — an unparseable limit
// used to render an empty dashboard while count still reported the real total.
function parseLimit(rawLimit, fallback = 50, max = 200) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, max));
}

function buildApiInventory() {
  return {
    implemented: [
      { method: "GET", path: "/api/health", purpose: "Health check" },
      { method: "POST", path: "/api/auth/login", purpose: "Allowlisted admin login" },
      { method: "POST", path: "/api/auth/validate", purpose: "Bearer token validation" },
      { method: "POST", path: "/api/auth/logout", purpose: "Client logout helper" },
      { method: "POST", path: "/api/auth/register", purpose: "Domain-restricted access request with password" },
      { method: "POST", path: "/api/auth/password", purpose: "Change own password" },
      { method: "POST", path: "/api/auth/verify", purpose: "Email verification code exchange" },
      { method: "GET", path: "/api/auth/registration-status", purpose: "Registration state lookup" },
      { method: "GET", path: "/api/admin/users", purpose: "Owner-only account list" },
      { method: "POST", path: "/api/admin/users/:email/decision", purpose: "Owner-only approve/reject/revoke" },
      { method: "GET", path: "/api/auth/me", purpose: "Authenticated admin profile" },
      { method: "POST", path: "/api/submissions", purpose: "Anonymous submission intake with enrichment" },
      { method: "GET", path: "/api/submissions/:id", purpose: "Single submission detail" },
      { method: "POST", path: "/api/submissions/:id/status", purpose: "Status workflow update" },
      { method: "GET", path: "/api/submissions/:id/messages", purpose: "Submission message thread" },
      { method: "POST", path: "/api/submissions/:id/messages", purpose: "Append message thread item" },
      { method: "POST", path: "/api/track/:id", purpose: "Anonymous reporter status tracking via access code" },
      { method: "POST", path: "/api/track/:id/messages", purpose: "Anonymous reporter reply via access code" },
      { method: "POST", path: "/api/track/:id/edit", purpose: "Reporter edits own report inside the edit window" },
      { method: "GET", path: "/api/priority-tiers", purpose: "Keyword to priority mapping and colour codes" },
      { method: "GET", path: "/api/appreciations/categories", purpose: "Appreciation categories" },
      { method: "POST", path: "/api/appreciations", purpose: "Submit appreciation (open, no account)" },
      { method: "GET", path: "/api/dashboard/appreciation", purpose: "Appreciation metrics and balance alerts" },
      { method: "GET", path: "/api/appreciations/:id/suggested-replies", purpose: "Suggested thank-you wording" },
      { method: "POST", path: "/api/appreciations/:id/acknowledge", purpose: "Acknowledge an appreciation" },
      { method: "POST", path: "/api/admin/spotlights/:id", purpose: "Owner-only spotlight toggle" },
      { method: "GET", path: "/api/export/brightspots", purpose: "Weekly recognition digest (json or html)" },
      { method: "GET", path: "/api/dashboard/submissions", purpose: "Filtered admin submission feed" },
      { method: "GET", path: "/api/dashboard/metrics", purpose: "Dashboard aggregate payload" },
      { method: "GET", path: "/api/dashboard/categories", purpose: "Category distribution payload" },
      { method: "GET", path: "/api/dashboard/trends", purpose: "Trend-only payload" },
      { method: "GET", path: "/api/dashboard/heatmap", purpose: "Department heatmap payload" },
      { method: "GET", path: "/api/dashboard/alerts", purpose: "High-priority alerts payload" },
      { method: "GET", path: "/api/dashboard/awaiting-reply", purpose: "Reports where the reporter is waiting on an answer" },
      { method: "POST", path: "/api/submissions/:id/escalate", purpose: "Route a report to compliance or legal" },
      { method: "GET", path: "/api/dashboard/escalated", purpose: "Reports currently escalated" },
      { method: "GET", path: "/api/dashboard/patterns", purpose: "Repeat clusters, spikes and near-duplicates" },
      { method: "GET", path: "/api/dashboard/export.pdf", purpose: "Print-ready leadership briefing" },
      { method: "GET", path: "/api/integrations/hris/webhook", purpose: "Outbound webhook contract and status" },
      { method: "GET", path: "/api/dashboard/export.csv", purpose: "CSV export" },
      { method: "GET", path: "/api/todo/apis", purpose: "API inventory and backlog" }
    ],
    backlog: [
    ]
  };
}

const app = express();
const authRateLimiter = createRateLimiter({
  name: "auth",
  windowMs: config.rateLimit.authWindowMs,
  maxRequests: config.rateLimit.authMaxRequests,
  message: "Too many authentication attempts. Please try again later."
});
const submissionRateLimiter = createRateLimiter({
  name: "submit",
  windowMs: config.rateLimit.submissionWindowMs,
  maxRequests: config.rateLimit.submissionMaxRequests,
  message: "Too many submissions from this client. Please wait before trying again."
});

app.use(express.json({ limit: "1mb" }));
app.use(applyCors);

app.get("/api/health", (request, response) => {
  response.json({
    status: "ok",
    service: "speak-up-api",
    timestamp: new Date().toISOString(),
    integrations: {
      email: mail.isConfigured(),
      webhook: webhooks.isConfigured(),
      tls: config.trustProxyTls || Boolean(config.tlsCertFile)
    }
  });
});

const REGISTRATION_HELP = {
  not_registered: "No account exists for this address. Register first.",
  pending_verification: "Check your email and enter the verification code to continue.",
  pending_approval: "Your account is awaiting approval from a SpeakUp owner.",
  rejected: "This registration was declined. Contact a SpeakUp owner.",
  revoked: "Access for this account has been revoked."
};

app.post("/api/auth/login", authRateLimiter, validateLoginRequest, async (request, response) => {
  const email = request.validated.email;
  const password = String(request.body?.password || "");

  if (!password) {
    return response.status(400).json({ error: "Password is required" });
  }

  const verdict = await canSignIn(email);
  const credentials = await checkPassword(email, password);

  // A single generic message for "no such account", "wrong password" and
  // "not approved": anything more specific turns this endpoint into a way to
  // discover which colleagues hold dashboard accounts.
  if (!verdict.allowed || !credentials.ok) {
    if (verdict.allowed === false && credentials.ok && REGISTRATION_HELP[verdict.reason]) {
      // Correct password but the account is not usable yet — safe to explain,
      // because they have already proved they own it.
      return response.status(403).json({
        error: REGISTRATION_HELP[verdict.reason],
        status: verdict.reason
      });
    }
    return response.status(401).json({ error: "Incorrect email or password" });
  }

  const token = createToken(email);
  audit.record("auth.login", email, { role: verdict.role });
  return response.json({ token, email, role: verdict.role, expiresInHours: config.tokenTtlHours });
});

app.post("/api/auth/password", requireAdmin, async (request, response, next) => {
  const current = String(request.body?.currentPassword || "");
  const next_ = String(request.body?.newPassword || "");

  const check = validatePassword(next_, request.user.email);
  if (!check.ok) {
    return next(createHttpError(400, check.reason));
  }

  const credentials = await checkPassword(request.user.email, current);
  if (!credentials.ok) {
    return next(createHttpError(401, "Current password is incorrect"));
  }

  await setPassword(request.user.email, next_);
  audit.record("account.password_changed", request.user.email, {});
  // A password changing without the owner knowing is how an account takeover
  // goes unnoticed; best effort, never blocking the change itself.
  mail.sendPasswordChanged(request.user.email).catch(() => {});

  return response.json({ changed: true, message: "Password updated." });
});

/**
 * Registration. Restricted to the configured corporate domains, and approval
 * by an existing owner is still required afterwards — see userService.
 */
app.post("/api/auth/register", authRateLimiter, validateLoginRequest, async (request, response, next) => {
  const email = request.validated.email;

  if (!isAllowedDomain(email) && !isBootstrapOwner(email)) {
    return next(createHttpError(403, `Registration is limited to ${config.adminDomains.map((d) => "@" + d).join(", ")} addresses`));
  }

  const fullName = String(request.body?.fullName || "").trim().slice(0, 120);
  const reason = String(request.body?.reason || "").trim().slice(0, 500);
  const password = String(request.body?.password || "");

  const check = validatePassword(password, email);
  if (!check.ok) {
    return next(createHttpError(400, check.reason));
  }

  const result = await registerUser({
    email, fullName, reason,
    passwordHash: await hashPassword(password)
  });

  if (result.alreadyApproved) {
    return response.json({ status: "approved", message: "This account is already approved. Sign in instead." });
  }
  if (result.blocked) {
    return next(createHttpError(403, "This registration was declined previously. Contact a SpeakUp owner."));
  }

  const payload = {
    status: "pending_verification",
    email,
    message: `We sent a 6-digit code to ${email}. It expires in ${config.verificationTtlMinutes} minutes.`,
    passwordPolicy: `At least ${MIN_LENGTH} characters.`
  };

  if (result.code) {
    if (config.smtpConfigured) {
      const delivery = await mail.sendVerificationCode(email, result.code, config.verificationTtlMinutes);
      if (!delivery.sent) {
        return next(createHttpError(502, "Could not send the verification email. Try again shortly."));
      }
    } else if (config.isProduction) {
      // Returning the code to the caller would let anyone register a
      // colleague's address and read every complaint.
      return next(createHttpError(503, "Email delivery is not configured, so registration cannot be completed."));
    } else {
      payload.devVerificationCode = result.code;
      payload.message += " (SMTP is not configured; code shown here for local testing only.)";
    }
  } else if (result.autoApproved) {
    payload.status = "approved";
    payload.message = "Account created. You can sign in now.";
  }

  return response.status(201).json(payload);
});

app.post("/api/auth/verify", authRateLimiter, validateLoginRequest, async (request, response, next) => {
  const code = String(request.body?.code || "").trim();
  if (!code) {
    return next(createHttpError(400, "code is required"));
  }

  const result = await verifyUser({ email: request.validated.email, code });
  if (result.error) {
    return next(createHttpError(400, result.error));
  }

  const approved = result.user.status === "approved";
  return response.json({
    status: result.user.status,
    message: approved
      ? "Email verified. Your account is active — you can sign in now."
      : "Email verified. A SpeakUp owner must approve your account before you can sign in.",
    user: publicUser(result.user)
  });
});

app.get("/api/auth/registration-status", authRateLimiter, async (request, response, next) => {
  const email = String(request.query.email || "").trim().toLowerCase();
  if (!email) {
    return next(createHttpError(400, "email is required"));
  }

  const verdict = await canSignIn(email);
  return response.json({
    email,
    allowed: verdict.allowed,
    status: verdict.allowed ? "approved" : verdict.reason,
    message: verdict.allowed ? "Approved. You can sign in." : (REGISTRATION_HELP[verdict.reason] || "Unknown state")
  });
});

/* ----- Owner-only user administration ----- */

function requireOwner(request, response, next) {
  if (request.user?.role !== "owner") {
    return next(createHttpError(403, "Only SpeakUp owners can manage accounts"));
  }
  return next();
}

app.get("/api/admin/users", requireAdmin, requireOwner, async (request, response) => {
  const users = await listUsers();
  return response.json({
    users: users.map(publicUser),
    domains: config.adminDomains
  });
});

app.post("/api/admin/users/:email/decision", requireAdmin, requireOwner, async (request, response, next) => {
  const decision = String(request.body?.decision || "").trim().toLowerCase();
  const allowed = { approve: "approved", reject: "rejected", revoke: "revoked" };

  if (!allowed[decision]) {
    return next(createHttpError(400, "decision must be approve, reject, or revoke"));
  }

  const target = String(request.params.email || "").trim().toLowerCase();
  if (target === request.user.email) {
    return next(createHttpError(400, "You cannot change your own access"));
  }

  const requestedRole = String(request.body?.role || "").trim().toLowerCase();
  const role = Object.keys(ROLE_LABELS).includes(requestedRole) ? requestedRole : undefined;

  // A department lead with no departments would see nothing, which reads as a
  // broken dashboard rather than a permissions decision.
  const departments = Array.isArray(request.body?.departments)
    ? request.body.departments.map((item) => String(item).trim()).filter(Boolean)
    : undefined;

  if (decision === "approve" && role === "lead" && (!departments || !departments.length)) {
    return next(createHttpError(400, "A department lead needs at least one department"));
  }

  const updated = await setUserStatus({
    email: target,
    status: allowed[decision],
    actorEmail: request.user.email,
    role,
    departments
  });

  if (!updated) {
    return next(createHttpError(404, "No such account"));
  }

  audit.record("account." + decision, request.user.email, {
    target, role: updated.role, status: updated.status
  });
  return response.json({ user: publicUser(updated) });
});

app.get("/api/admin/roles", requireAdmin, requireOwner, (request, response) => {
  response.json({
    roles: Object.entries(ROLE_LABELS).map(([value, label]) => ({
      value,
      label,
      capabilities: capabilitiesFor(value)
    }))
  });
});

app.post("/api/auth/validate", (request, response) => {
  const explicitToken = request.body?.token;
  const header = request.headers.authorization || "";
  const headerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  const result = verifyToken(explicitToken || headerToken);

  if (!result.valid) {
    return response.status(401).json({ valid: false, reason: result.reason });
  }

  return response.json({ valid: true, user: result.user });
});

app.post("/api/auth/logout", (request, response) => {
  response.status(204).end();
});

app.get("/api/auth/me", requireAdmin, (request, response) => {
  response.json({ user: request.user, scope: describeScope(request.user) });
});

// accessCodeHash is the reporter's credential; messageText/keywords are fine for
// the reporter to see but the hash must never leave the server.
function publicSubmission(submission) {
  const { accessCodeHash, ...safe } = submission;
  return safe;
}

/**
 * Every admin-facing read goes through here. Centralising it means a new
 * endpoint cannot accidentally bypass role segregation — the alternative,
 * filtering per route, is how leaks happen.
 */
async function scopedSubmissions(user, query) {
  const all = await listSubmissions();
  const permitted = visibleSubmissions(user, all);
  return filterSubmissions(permitted, query || {});
}

app.post("/api/submissions", submissionRateLimiter, validateSubmissionRequest, async (request, response) => {
  const { submission, accessCode } = analyzeSubmission({
    messageText: request.validated.messageText,
    department: request.validated.department,
    region: request.validated.region,
    channel: request.validated.channel,
    browserLocale: request.validated.browserLocale
  });

  const created = await createSubmission(submission);

  // Kudos pipeline: a clearly positive submission is praise that arrived down
  // the complaints channel. Mirror it into the recognition queue so it is not
  // buried in a list nobody reads for good news. The original stays put — this
  // is a copy, not a move, so no audit trail is broken.
  if (submission.sentiment === "positive" && !submission.flags.spam) {
    try {
      await appreciation.createAppreciation({
        recipientName: submission.department && submission.department !== "Unspecified"
          ? `${submission.department} team`
          : "Unnamed",
        recipientTeam: submission.department,
        category: "teamwork",
        messageText: submission.messageText,
        fromTeam: submission.region
      });
    } catch (error) {
      // Recognition is a nice-to-have; never fail an intake over it.
      console.warn("[speakup] could not mirror positive submission into recognition:", error.message);
    }
  }

  // Fire and forget: a slow HRIS must not hold up the person filing a report.
  webhooks.emitAsync(webhooks.EVENTS.CREATED, created);

  // accessCode is returned exactly once, here. It is not recoverable later —
  // only its hash is stored, which is what keeps the reporter unidentifiable.
  return response.status(201).json({
    submission: publicSubmission(created),
    accessCode
  });
});

/**
 * Reporter-side access. A reporter has no account and no token — they hold only
 * the access code shown once at submission time. These routes authenticate by
 * that code alone, so they are rate limited like the public intake and never
 * accept an id without a matching code.
 */
async function resolveByAccessCode(request) {
  const accessCode = String(request.body?.accessCode || request.query.accessCode || "").trim();
  if (!accessCode) {
    return { error: createHttpError(400, "accessCode is required") };
  }

  const submission = await getSubmissionById(String(request.params.id || "").trim());
  if (!submission || !submission.accessCodeHash) {
    // Same response as a wrong code so the endpoint cannot be used to test
    // whether a given submission id exists.
    return { error: createHttpError(404, "No submission matches that reference and access code") };
  }

  const provided = Buffer.from(hashAccessCode(accessCode), "hex");
  const expected = Buffer.from(submission.accessCodeHash, "hex");
  const matches = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);

  if (!matches) {
    return { error: createHttpError(404, "No submission matches that reference and access code") };
  }

  return { submission };
}

app.post("/api/track/:id", submissionRateLimiter, async (request, response, next) => {
  const result = await resolveByAccessCode(request);
  if (result.error) {
    return next(result.error);
  }

  const submission = result.submission;
  const editableUntil = new Date(submission.createdAt).getTime() + config.editWindowMinutes * 60 * 1000;

  const notices = notifications.forSubmission(submission.id);
  notifications.markRead(submission.id);

  return response.json({
    notifications: notices,
    submission: {
      id: submission.id,
      status: submission.status,
      statusNote: submission.statusNote || null,
      category: submission.category,
      summary: submission.summary,
      messageText: submission.messageText,
      keywords: submission.keywords,
      priority: submission.priority,
      priorityLabel: submission.priorityLabel,
      priorityColour: submission.priorityColour,
      sla: submission.sla,
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt
    },
    // The reporter can correct their own wording for a short window; after that
    // the record is fixed so leadership is not acting on shifting text.
    canEdit: Date.now() < editableUntil && submission.status === "open",
    editableUntil: new Date(editableUntil).toISOString(),
    editWindowMinutes: config.editWindowMinutes,
    messages: Array.isArray(submission.messages) ? submission.messages : []
  });
});

app.post("/api/track/:id/messages", submissionRateLimiter, async (request, response, next) => {
  const messageText = String(request.body?.messageText || "").trim();
  if (!messageText) {
    return next(createHttpError(400, "messageText is required"));
  }
  if (messageText.length > 5000) {
    return next(createHttpError(400, "messageText must be 5000 characters or fewer"));
  }

  const result = await resolveByAccessCode(request);
  if (result.error) {
    return next(result.error);
  }

  // authorType is forced to "reporter" — this route can never be used to forge
  // a message that appears to come from the company.
  const updated = await updateSubmission(result.submission.id, (currentValue) => ({
    ...currentValue,
    messages: [
      ...(Array.isArray(currentValue.messages) ? currentValue.messages : []),
      {
        id: `msg-${crypto.randomUUID()}`,
        authorType: "reporter",
        messageText,
        createdAt: new Date().toISOString()
      }
    ],
    updatedAt: new Date().toISOString()
  }));

  return response.status(201).json({
    submissionId: updated.id,
    messages: updated.messages
  });
});

app.post("/api/track/:id/edit", submissionRateLimiter, async (request, response, next) => {
  const messageText = String(request.body?.messageText || "").trim();
  if (messageText.length < 10) {
    return next(createHttpError(400, "messageText must be at least 10 characters long"));
  }
  if (messageText.length > config.maxMessageLength) {
    return next(createHttpError(400, `messageText must be ${config.maxMessageLength} characters or fewer`));
  }

  const result = await resolveByAccessCode(request);
  if (result.error) {
    return next(result.error);
  }

  const existing = result.submission;
  const editableUntil = new Date(existing.createdAt).getTime() + config.editWindowMinutes * 60 * 1000;

  if (Date.now() > editableUntil) {
    return next(createHttpError(403, `The ${config.editWindowMinutes}-minute edit window for this report has closed.`));
  }
  // Once someone has acted on it, the text must stop moving.
  if (existing.status !== "open") {
    return next(createHttpError(403, "This report has already been reviewed and can no longer be edited."));
  }

  // Re-run the analysis: an edit can change the category and the priority.
  const { submission: reanalysed } = analyzeSubmission({
    messageText,
    department: existing.department,
    region: existing.region,
    channel: existing.channel,
    browserLocale: existing.metadata?.browserLocale
  });

  const updated = await updateSubmission(existing.id, (currentValue) => ({
    ...currentValue,
    messageText,
    summary: reanalysed.summary,
    category: reanalysed.category,
    keywords: reanalysed.keywords,
    sentiment: reanalysed.sentiment,
    priority: reanalysed.priority,
    priorityScore: reanalysed.priorityScore,
    priorityLabel: reanalysed.priorityLabel,
    priorityColour: reanalysed.priorityColour,
    priorityReason: reanalysed.priorityReason,
    priorityTerms: reanalysed.priorityTerms,
    sla: reanalysed.sla,
    flags: reanalysed.flags,
    quarantined: reanalysed.quarantined,
    editedAt: new Date().toISOString(),
    editCount: (currentValue.editCount || 0) + 1,
    updatedAt: new Date().toISOString()
  }));

  return response.json({
    submission: {
      id: updated.id,
      messageText: updated.messageText,
      summary: updated.summary,
      category: updated.category,
      priority: updated.priority,
      priorityLabel: updated.priorityLabel,
      keywords: updated.keywords,
      editedAt: updated.editedAt,
      editCount: updated.editCount
    },
    editableUntil: new Date(editableUntil).toISOString(),
    canEdit: Date.now() < editableUntil
  });
});

app.get("/api/priority-tiers", (request, response) => {
  response.json({ tiers: publicTiers() });
});

app.get("/api/submissions/:id", requireAdmin, async (request, response) => {
  const submission = await getSubmissionById(request.params.id);
  // Out-of-scope reads return the same 404 as a missing record, so the endpoint
  // cannot be used to confirm that a restricted complaint exists.
  if (!submission || !canSeeSubmission(request.user, submission)) {
    return response.status(404).json({ error: "Submission not found" });
  }
  audit.recordRead(request, [submission.id]);
  return response.json({ submission: redact(request.user, submission) });
});

app.post("/api/submissions/:id/status", requireAdmin, validateStatusUpdateRequest, async (request, response, next) => {
  const existing = await getSubmissionById(request.params.id);
  if (!existing || !canSeeSubmission(request.user, existing)) {
    return response.status(404).json({ error: "Submission not found" });
  }
  if (!capabilitiesFor(request.user.role).respond) {
    return next(createHttpError(403, "Your role cannot change complaint status"));
  }

  const status = request.validated.status;
  const updated = await updateSubmission(request.params.id, (currentValue) => ({
    ...currentValue,
    status,
    statusNote: request.validated.note || currentValue.statusNote,
    updatedAt: new Date().toISOString()
  }));

  if (!updated) {
    return response.status(404).json({ error: "Submission not found" });
  }

  audit.record("submission.status", request.user.email, {
    id: updated.id, from: existing.status, to: status
  });
  // The reporter has no email, so the notice waits for them on the tracking
  // page rather than being sent anywhere.
  notifications.announceStatus(updated.id, status, request.validated.note);
  webhooks.emitAsync(
    status === "resolved" ? webhooks.EVENTS.RESOLVED : webhooks.EVENTS.STATUS,
    updated, { previousStatus: existing.status });

  return response.json({ submission: publicSubmission(updated) });
});

app.get("/api/submissions/:id/messages", requireAdmin, async (request, response) => {
  const submission = await getSubmissionById(request.params.id);
  if (!submission || !canSeeSubmission(request.user, submission)) {
    return response.status(404).json({ error: "Submission not found" });
  }

  return response.json({
    submissionId: submission.id,
    messages: Array.isArray(submission.messages) ? submission.messages : []
  });
});

app.post("/api/submissions/:id/messages", requireAdmin, validateMessageRequest, async (request, response, next) => {
  const existing = await getSubmissionById(request.params.id);
  if (!existing || !canSeeSubmission(request.user, existing)) {
    return response.status(404).json({ error: "Submission not found" });
  }
  if (!capabilitiesFor(request.user.role).respond) {
    return next(createHttpError(403, "Your role cannot reply to reporters"));
  }

  const updated = await updateSubmission(request.params.id, (currentValue) => ({
    ...currentValue,
    messages: [
      ...(Array.isArray(currentValue.messages) ? currentValue.messages : []),
      {
        id: `msg-${Date.now()}`,
        authorType: request.validated.authorType,
        messageText: request.validated.messageText,
        createdAt: new Date().toISOString()
      }
    ],
    updatedAt: new Date().toISOString()
  }));

  if (!updated) {
    return response.status(404).json({ error: "Submission not found" });
  }

  if (request.validated.authorType === "admin") {
    audit.record("submission.reply", request.user.email, { id: updated.id });
    notifications.announceReply(updated.id);
  }

  return response.status(201).json({
    submissionId: updated.id,
    messages: updated.messages
  });
});

app.get("/api/dashboard/submissions", requireAdmin, async (request, response) => {
  // Default to priority order — the whole point of a triage feed is that the
  // most urgent ticket is first, not the most recent.
  const sort = String(request.query.sort || "priority").toLowerCase();
  const filtered = (await scopedSubmissions(request.user, request.query))
    .sort(sort === "recent"
      ? (left, right) => new Date(right.createdAt) - new Date(left.createdAt)
      : comparePriority);
  const limit = parseLimit(request.query.limit);

  const page = filtered.slice(0, limit);
  // Reading complaints is the event worth recording: it is the moment someone
  // could learn something about a colleague.
  audit.recordRead(request, page.map((item) => item.id));

  return response.json({
    count: filtered.length,
    limit,
    sort,
    // Echoed back so the page can state what it is showing rather than
    // guessing from its own inputs.
    filters: {
      search: request.query.search || null,
      days: request.query.days || null,
      from: request.query.from || null,
      to: request.query.to || null,
      status: request.query.status || null,
      category: request.query.category || null,
      priority: request.query.priority || null,
      department: request.query.department || null
    },
    submissions: page.map((item) => redact(request.user, item))
  });
});

app.get("/api/dashboard/metrics", requireAdmin, async (request, response) => {
  const filtered = await scopedSubmissions(request.user, request.query);
  const metrics = buildMetrics(filtered);
  metrics.latestSubmissions = metrics.latestSubmissions.map((item) => redact(request.user, item));
  return response.json({ metrics, scope: describeScope(request.user) });
});

app.get("/api/dashboard/categories", requireAdmin, async (request, response) => {
  const filtered = await scopedSubmissions(request.user, request.query);
  const metrics = buildMetrics(filtered);
  return response.json({
    categories: Object.entries(metrics.categoryCounts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([category, count]) => ({ category, count }))
  });
});

app.get("/api/dashboard/trends", requireAdmin, async (request, response) => {
  const filtered = await scopedSubmissions(request.user, request.query);
  const metrics = buildMetrics(filtered);
  return response.json({ trends: metrics.weeklyTrend });
});

app.get("/api/dashboard/heatmap", requireAdmin, async (request, response) => {
  const filtered = await scopedSubmissions(request.user, request.query);
  const metrics = buildMetrics(filtered);
  return response.json({ heatmap: metrics.departmentHeatmap });
});

/**
 * Reports where the reporter has replied more recently than anyone answered.
 * Without this an admin has to open every thread to discover a waiting reply.
 */
app.get("/api/dashboard/awaiting-reply", requireAdmin, async (request, response) => {
  const filtered = await scopedSubmissions(request.user, request.query);

  const waiting = filtered.filter((submission) => {
    const messages = submission.messages || [];
    if (!messages.length) { return false; }
    return messages[messages.length - 1].authorType === "reporter";
  }).sort(comparePriority);

  return response.json({
    count: waiting.length,
    submissions: waiting.slice(0, 25).map((item) => redact(request.user, item))
  });
});

app.get("/api/dashboard/alerts", requireAdmin, async (request, response) => {
  const filtered = await scopedSubmissions(request.user, request.query);
  const alerts = filtered
    .filter((submission) => submission.priority === "P1" || submission.flags?.urgent || submission.flags?.sensitive)
    .sort(comparePriority)
    .map((submission) => ({
      id: submission.id,
      category: submission.category,
      summary: submission.summary,
      priority: submission.priority,
      priorityScore: submission.priorityScore,
      priorityLabel: submission.priorityLabel,
      priorityColour: submission.priorityColour,
      priorityReason: submission.priorityReason,
      sla: submission.sla,
      status: submission.status,
      department: submission.department,
      createdAt: submission.createdAt
    }));

  return response.json({ alerts });
});

app.get("/api/dashboard/export.csv", requireAdmin, async (request, response, next) => {
  if (!capabilitiesFor(request.user.role).export) {
    return next(createHttpError(403, "Your role cannot export complaint data"));
  }
  const filtered = (await scopedSubmissions(request.user, request.query)).sort(comparePriority);
  // An export takes complaint text out of the system entirely, so it is logged
  // in full rather than as a count.
  audit.record("export.csv", request.user.email, {
    count: filtered.length, ids: filtered.map((item) => item.id).slice(0, 100)
  });
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", "attachment; filename=speakup-submissions.csv");
  return response.send(toCsv(filtered));
});

/* ---------------------------- APPRECIATION ----------------------------
 * The positive counterpart to a complaint. Submitting is open to everyone and
 * needs no account, exactly like a report — but here the RECIPIENT is named and
 * the nominator stays anonymous unless they later choose otherwise.
 * -------------------------------------------------------------------- */

app.get("/api/appreciations/categories", (request, response) => {
  response.json({ categories: appreciation.CATEGORIES });
});

app.post("/api/appreciations", submissionRateLimiter, async (request, response, next) => {
  const messageText = String(request.body?.messageText || "").trim();
  const recipientName = String(request.body?.recipientName || "").trim();

  if (!recipientName) {
    return next(createHttpError(400, "Who are you appreciating?"));
  }
  if (messageText.length < 10) {
    return next(createHttpError(400, "Please write at least 10 characters"));
  }
  if (messageText.length > config.maxMessageLength) {
    return next(createHttpError(400, `Message must be ${config.maxMessageLength} characters or fewer`));
  }

  const created = await appreciation.createAppreciation({
    recipientName,
    recipientTeam: request.body?.recipientTeam,
    category: String(request.body?.category || "").trim(),
    messageText,
    fromTeam: request.body?.fromTeam,
    // Optional and decided here. Blank means they preferred not to be named.
    nominatorName: request.body?.nominatorName
  });

  return response.status(201).json({
    appreciation: appreciation.publicAppreciation(created.appreciation)
  });
});

app.get("/api/dashboard/appreciation", requireAdmin, async (request, response) => {
  const list = await appreciation.listAppreciations(request.query);
  const submissions = await listSubmissions();
  const knownTeams = [...new Set(submissions.map((s) => s.department))];

  return response.json({
    metrics: appreciation.buildAppreciationMetrics(list, knownTeams),
    categories: appreciation.CATEGORIES,
    appreciations: list.slice(0, 50).map(appreciation.publicAppreciation)
  });
});

app.get("/api/appreciations/:id/suggested-replies", requireAdmin, async (request, response, next) => {
  const found = await appreciation.getById(request.params.id);
  if (!found) {
    return next(createHttpError(404, "No such appreciation"));
  }
  return response.json({ suggestions: appreciation.suggestReplies(found) });
});

app.post("/api/appreciations/:id/acknowledge", requireAdmin, async (request, response, next) => {
  if (!capabilitiesFor(request.user.role).respond) {
    return next(createHttpError(403, "Your role cannot acknowledge appreciation"));
  }

  const updated = await appreciation.updateAppreciation(request.params.id, (current) => ({
    ...current,
    status: "acknowledged",
    acknowledgedBy: request.user.email,
    acknowledgedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));

  if (!updated) {
    return next(createHttpError(404, "No such appreciation"));
  }
  return response.json({ appreciation: appreciation.publicAppreciation(updated) });
});

// Spotlights are an owner decision: publishing praise is a visible act, so it
// carries the same governance as changing someone's access.
app.post("/api/admin/spotlights/:id", requireAdmin, requireOwner, async (request, response, next) => {
  const on = request.body?.spotlight !== false;

  const updated = await appreciation.updateAppreciation(request.params.id, (current) => ({
    ...current,
    spotlight: on,
    spotlightBy: on ? request.user.email : null,
    spotlightAt: on ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString()
  }));

  if (!updated) {
    return next(createHttpError(404, "No such appreciation"));
  }
  return response.json({ appreciation: appreciation.publicAppreciation(updated) });
});

app.get("/api/export/brightspots", requireAdmin, async (request, response, next) => {
  if (!capabilitiesFor(request.user.role).sensitive) {
    return next(createHttpError(403, "Your role cannot generate the digest"));
  }

  const list = await appreciation.listAppreciations({});
  const digest = appreciation.buildDigest(list, { days: Number(request.query.days) || 7 });

  if (String(request.query.format || "json").toLowerCase() === "html") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    return response.send(appreciation.digestToHtml(digest));
  }
  return response.json({ digest });
});

/**
 * Escalation — hand a report to compliance or legal.
 *
 * Deliberately separate from status: a report can be escalated and still open,
 * and withdrawing an escalation must not silently close it. Only roles that
 * can see sensitive reports may escalate, since the reports most likely to
 * need it are exactly the ones a department lead cannot read.
 */
const ESCALATION_TARGETS = new Set(["compliance", "legal", "hr", "board", "external"]);

app.post("/api/submissions/:id/escalate", requireAdmin, async (request, response, next) => {
  if (!capabilitiesFor(request.user.role).sensitive) {
    return next(createHttpError(403, "Your role cannot escalate reports"));
  }

  const existing = await getSubmissionById(request.params.id);
  if (!existing || !canSeeSubmission(request.user, existing)) {
    return response.status(404).json({ error: "Submission not found" });
  }

  const withdraw = request.body?.escalate === false;
  const target = String(request.body?.to || "").trim().toLowerCase();
  const note = String(request.body?.note || "").trim().slice(0, 1000);

  if (!withdraw && !ESCALATION_TARGETS.has(target)) {
    return next(createHttpError(400,
      `to must be one of: ${[...ESCALATION_TARGETS].join(", ")}`));
  }
  if (!withdraw && !note) {
    return next(createHttpError(400, "A reason is required to escalate"));
  }

  const now = new Date().toISOString();
  const updated = await updateSubmission(existing.id, (current) => ({
    ...current,
    escalated: !withdraw,
    escalatedTo: withdraw ? null : target,
    escalatedBy: withdraw ? null : request.user.email,
    escalatedAt: withdraw ? null : now,
    escalationNote: withdraw ? null : note,
    updatedAt: now
  }));

  audit.record(withdraw ? "submission.escalation_withdrawn" : "submission.escalated",
    request.user.email, { id: updated.id, to: withdraw ? null : target });
  if (!withdraw) {
    webhooks.emitAsync(webhooks.EVENTS.ESCALATED, updated, { escalatedTo: target });
  }

  // The reporter is told it moved, but not to whom — naming the destination
  // could identify who is handling it in a small function.
  if (!withdraw) {
    notifications.create(updated.id, "status",
      "Your report has been escalated",
      "It has been passed to a specialist team for review.");
  }

  return response.json({ submission: publicSubmission(updated) });
});

app.get("/api/dashboard/escalated", requireAdmin, async (request, response, next) => {
  if (!capabilitiesFor(request.user.role).sensitive) {
    return next(createHttpError(403, "Your role cannot view escalations"));
  }
  const filtered = await scopedSubmissions(request.user, request.query);
  const escalated = filtered.filter((item) => item.escalated).sort(comparePriority);
  return response.json({
    count: escalated.length,
    submissions: escalated.map((item) => redact(request.user, item))
  });
});

/**
 * Leadership briefing, print-ready.
 *
 * Served as HTML with print styles rather than a generated PDF: the browser's
 * own "Save as PDF" produces a better document than a bundled renderer, and
 * adding a PDF library for one report would be a large dependency for a small
 * feature. @page rules control the paper size and margins.
 */
function briefingHtml(user, metrics, submissions, escalated, range) {
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const totals = metrics.totals || {};
  const open = submissions.filter((item) => item.status === "open");
  const SLA_DAYS = { P1: 1, P2: 5, P3: 30 };
  const overdue = open.filter((item) => {
    const days = (Date.now() - new Date(item.createdAt).getTime()) / 86400000;
    return days > (SLA_DAYS[item.priority] || 30);
  });

  const byDept = {};
  submissions.forEach((item) => { byDept[item.department] = (byDept[item.department] || 0) + 1; });
  const departments = Object.entries(byDept).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const categories = Object.entries(metrics.categoryCounts || {}).sort((a, b) => b[1] - a[1]);
  const attention = submissions
    .filter((item) => item.status !== "resolved")
    .sort(comparePriority)
    .slice(0, 10);

  const colour = { P1: "#dc2626", P2: "#d97706", P3: "#2a78d6" };
  const row = (label, value, total) => `
    <tr>
      <td style="padding:6px 0;font-size:12px;">${esc(label)}</td>
      <td style="padding:6px 0;width:180px;">
        <div style="background:#eef1f5;height:7px;border-radius:4px;overflow:hidden;">
          <div style="background:#2a78d6;height:100%;width:${total ? (value / total) * 100 : 0}%;"></div>
        </div>
      </td>
      <td style="padding:6px 0 6px 10px;font-size:12px;font-weight:700;text-align:right;width:34px;">${esc(value)}</td>
    </tr>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>SpeakUp briefing ${esc(new Date().toISOString().slice(0, 10))}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font: 400 13px/1.6 -apple-system, "Segoe UI", Arial, sans-serif; color: #0f1420; margin: 0; }
  h1 { font-size: 22px; letter-spacing: -.5px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e8ebf0; }
  .muted { color: #5b6474; font-size: 12px; }
  .kpis { display: flex; gap: 10px; margin: 18px 0 4px; }
  .kpi { flex: 1; border: 1px solid #e8ebf0; border-radius: 10px; padding: 12px 14px; }
  .kpi-n { font-size: 24px; font-weight: 700; letter-spacing: -1px; }
  .kpi-l { font-size: 11px; color: #5b6474; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  .item { border: 1px solid #e8ebf0; border-left: 3px solid #ccc; border-radius: 8px;
          padding: 10px 12px; margin-bottom: 8px; page-break-inside: avoid; }
  .item-head { font-size: 11.5px; color: #5b6474; margin-bottom: 4px; }
  .badge { font-weight: 700; font-size: 10.5px; padding: 2px 7px; border-radius: 20px; }
  .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e8ebf0;
          font-size: 10.5px; color: #98a1b0; }
  /* Print exactly what is on screen; a briefing with the bars stripped out is
     harder to read than one with a little ink. */
  @media print {
    .noprint { display: none; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style></head><body>

<div class="noprint" style="background:#14162a;color:#fff;padding:12px 16px;border-radius:10px;margin-bottom:20px;font-size:13px;">
  Use your browser's <strong>Print &rarr; Save as PDF</strong> to file this.
  <button onclick="window.print()" style="float:right;background:#fff;color:#14162a;border:0;border-radius:7px;padding:6px 14px;font-weight:600;cursor:pointer;">Print</button>
</div>

<h1>SpeakUp leadership briefing</h1>
<div class="muted">
  ${esc(new Date().toDateString())}${range ? " &middot; " + esc(range) : ""}
  &middot; prepared for ${esc(user.email)}
</div>

<div class="kpis">
  <div class="kpi"><div class="kpi-n">${esc(totals.submissions || 0)}</div><div class="kpi-l">Reports in scope</div></div>
  <div class="kpi"><div class="kpi-n" style="color:#dc2626;">${esc(open.length)}</div><div class="kpi-l">Still open</div></div>
  <div class="kpi"><div class="kpi-n" style="color:${overdue.length ? "#d97706" : "#059669"};">${esc(overdue.length)}</div><div class="kpi-l">Past response target</div></div>
  <div class="kpi"><div class="kpi-n" style="color:#4a3aa7;">${esc(escalated.length)}</div><div class="kpi-l">Escalated</div></div>
</div>

<h2>Where things stand</h2>
<p style="font-size:13px;margin:0;">
  ${open.length
    ? `${open.length} report${open.length > 1 ? "s remain" : " remains"} open` +
      (overdue.length ? `, of which <strong>${overdue.length} ${overdue.length > 1 ? "have" : "has"} passed the response target</strong>` : ", all within target") + "."
    : "Nothing is currently open."}
  ${escalated.length ? ` ${escalated.length} ${escalated.length > 1 ? "reports have" : "report has"} been escalated for specialist review.` : ""}
  ${departments.length ? ` ${esc(departments[0][0])} accounts for the largest share at ${Math.round((departments[0][1] / (submissions.length || 1)) * 100)}%.` : ""}
</p>

<h2>By category</h2>
<table>${categories.map(([name, n]) => row(name, n, categories[0] ? categories[0][1] : 1)).join("")}</table>

<h2>By department</h2>
<table>${departments.map(([name, n]) => row(name, n, departments[0] ? departments[0][1] : 1)).join("")}</table>

<h2>Needs attention</h2>
${attention.length ? attention.map((item) => `
  <div class="item" style="border-left-color:${colour[item.priority] || "#ccc"};">
    <div class="item-head">
      <span class="badge" style="background:${colour[item.priority]}1a;color:${colour[item.priority]};">${esc(item.priority)}</span>
      &nbsp;${esc(item.id)} &middot; ${esc(item.category)} &middot; ${esc(item.department)}
      &middot; ${esc(item.status)}${item.escalated ? " &middot; escalated" : ""}
    </div>
    <div style="font-size:12.5px;">${esc(item.summary || "")}</div>
  </div>`).join("") : '<div class="muted">Nothing outstanding.</div>'}

<div class="foot">
  Reports are anonymous by design — nothing in this document identifies who filed anything.
  Generated from SpeakUp on ${esc(new Date().toISOString())}.
</div>
</body></html>`;
}

app.get("/api/dashboard/export.pdf", requireAdmin, async (request, response, next) => {
  if (!capabilitiesFor(request.user.role).export) {
    return next(createHttpError(403, "Your role cannot export"));
  }

  const filtered = await scopedSubmissions(request.user, request.query);
  const metrics = buildMetrics(filtered);
  const escalated = filtered.filter((item) => item.escalated);

  audit.record("export.briefing", request.user.email, { count: filtered.length });

  const range = request.query.days ? `last ${request.query.days} days` : null;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  return response.send(briefingHtml(request.user, metrics, filtered, escalated, range));
});

/**
 * What the webhook sends, so an integrator does not have to read the source or
 * trigger a real complaint to find out.
 */
app.get("/api/integrations/hris/webhook", requireAdmin, requireOwner, (request, response) => {
  response.json({
    ...webhooks.describe(),
    signature: "HMAC-SHA256 of the raw body, sent as X-SpeakUp-Signature: sha256=<hex>",
    verify: "Recompute the HMAC over the exact bytes received and compare in constant time.",
    note: "Complaint text is never sent. Metadata only — come back and read the report here, where the role rules still apply."
  });
});

/**
 * Detected patterns. Restricted to roles that can see sensitive reports: a
 * pattern names a department and a count, which in a small team can identify
 * the person being complained about even without the report text.
 */
app.get("/api/dashboard/patterns", requireAdmin, async (request, response, next) => {
  if (!capabilitiesFor(request.user.role).sensitive) {
    return next(createHttpError(403, "Your role cannot view detected patterns"));
  }

  const filtered = await scopedSubmissions(request.user, request.query);
  const result = patterns.detect(filtered, { days: Number(request.query.days) || undefined });

  return response.json(result);
});

app.get("/api/todo/apis", (request, response) => {
  response.json(buildApiInventory());
});

// Serve the frontend from the API so the browser talks to a single origin.
// This is an explicit allowlist, NOT express.static on the project root: the
// root contains backend/data/submissions.json (every anonymous complaint),
// .env and node_modules, none of which may ever be reachable over HTTP.
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PUBLIC_PAGES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/submit.html": "submit.html",
  "/login.html": "login.html",
  "/track.html": "track.html",
  "/register.html": "register.html",
  "/appreciation.html": "appreciation.html",
  "/users.html": "users.html"
};

Object.entries(PUBLIC_PAGES).forEach(([route, file]) => {
  app.get(route, (request, response, next) => {
    response.sendFile(path.join(PROJECT_ROOT, file), (error) => {
      if (error) { next(); }
    });
  });
});

app.use("/assets", express.static(path.join(PROJECT_ROOT, "assets"), {
  dotfiles: "deny",
  index: false
}));

app.use(notFoundHandler);

app.use(errorHandler);

module.exports = app;
