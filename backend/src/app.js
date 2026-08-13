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

function filterSubmissions(submissions, query) {
  // Spam is excluded from every dashboard, metric and export by default so it
  // cannot inflate counts or pollute the word cloud. ?includeSpam=true opts in
  // for a review queue.
  const includeSpam = String(query.includeSpam || "").toLowerCase() === "true";

  return submissions.filter((submission) => {
    const isSpam = submission.quarantined === true || submission.flags?.spam === true;
    if (isSpam && !includeSpam) {
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
    if (query.search) {
      const haystack = `${submission.messageText} ${submission.summary} ${submission.category}`.toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) {
        return false;
      }
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
      { method: "POST", path: "/api/appreciations/:id/reveal", purpose: "Nominator opts in to attribution" },
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
      { method: "GET", path: "/api/dashboard/export.csv", purpose: "CSV export" },
      { method: "GET", path: "/api/todo/apis", purpose: "API inventory and backlog" }
    ],
    backlog: [
      { method: "GET", path: "/api/dashboard/export.pdf", phase: "Phase 2", purpose: "Leadership PDF export" },
      { method: "POST", path: "/api/auth/sso/callback", phase: "Phase 3", purpose: "Enterprise SSO callback" },
      { method: "POST", path: "/api/integrations/hris/webhook", phase: "Phase 3", purpose: "HRIS synchronization" },
      { method: "POST", path: "/api/submissions/:id/escalate", phase: "Phase 3", purpose: "Compliance escalation workflow" },
      { method: "GET", path: "/api/compliance/audit-log", phase: "Phase 3", purpose: "Compliance audit trail" }
    ]
  };
}

const app = express();
const authRateLimiter = createRateLimiter({
  windowMs: config.rateLimit.authWindowMs,
  maxRequests: config.rateLimit.authMaxRequests,
  message: "Too many authentication attempts. Please try again later."
});
const submissionRateLimiter = createRateLimiter({
  windowMs: config.rateLimit.submissionWindowMs,
  maxRequests: config.rateLimit.submissionMaxRequests,
  message: "Too many submissions from this client. Please wait before trying again."
});

app.use(express.json({ limit: "1mb" }));
app.use(applyCors);

app.get("/api/health", (request, response) => {
  response.json({ status: "ok", service: "speak-up-api", timestamp: new Date().toISOString() });
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

  // Returning the code to the caller is a development affordance only. Doing it
  // in production would let anyone register any colleague's address and read
  // every complaint, so it is withheld and the request fails loudly instead.
  if (!config.smtpConfigured) {
    if (config.isProduction) {
      return next(createHttpError(503, "Email delivery is not configured, so registration cannot be completed."));
    }
    payload.devVerificationCode = result.code;
    payload.message += " (SMTP is not configured; code returned here for local testing only.)";
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

  return response.json({
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

  return response.json({
    count: filtered.length,
    limit,
    sort,
    submissions: filtered.slice(0, limit).map((item) => redact(request.user, item))
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
    fromTeam: request.body?.fromTeam
  });

  // The code is returned once. It is the only way the nominator can come back
  // and attach their name, and only a hash of it is stored.
  return response.status(201).json({
    appreciation: appreciation.publicAppreciation(created.appreciation),
    accessCode: created.accessCode
  });
});

app.post("/api/appreciations/:id/reveal", submissionRateLimiter, async (request, response, next) => {
  const result = await appreciation.revealNominator(
    String(request.params.id || "").trim(),
    String(request.body?.accessCode || "").trim(),
    request.body?.nominatorName
  );

  if (result.error) {
    return next(createHttpError(404, result.error));
  }
  return response.json({ appreciation: appreciation.publicAppreciation(result.appreciation) });
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
