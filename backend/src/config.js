const crypto = require("crypto");
const path = require("path");

const DEFAULT_ADMIN_EMAILS = ["jane.doe@company.com", "admin@speakup.local"];
const DEFAULT_ADMIN_DOMAINS = ["comviva.com"];

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

function parseAdminEmails(value) {
  return parseList(value, DEFAULT_ADMIN_EMAILS);
}

// A committed literal default is what lets anyone mint an admin token for an
// arbitrary email offline, so production refuses to boot without a real secret
// and development gets an ephemeral one (tokens do not survive a restart).
function resolveAuthSecret(environment) {
  const configured = process.env.SPEAKUP_ADMIN_SECRET;

  if (configured && configured.length >= 32) {
    return configured;
  }

  if (environment === "production") {
    throw new Error(
      configured
        ? "SPEAKUP_ADMIN_SECRET must be at least 32 characters"
        : "SPEAKUP_ADMIN_SECRET is required in production"
    );
  }

  console.warn(
    configured
      ? "[speakup] SPEAKUP_ADMIN_SECRET is shorter than 32 characters; using an ephemeral secret instead."
      : "[speakup] SPEAKUP_ADMIN_SECRET is not set; generating an ephemeral secret. Tokens expire on restart."
  );

  return crypto.randomBytes(48).toString("hex");
}

const nodeEnv = process.env.NODE_ENV || "development";

module.exports = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  port: Number(process.env.PORT || 3000),

  // Defaults to loopback so a dev machine is not silently published to the
  // office network. Set SPEAKUP_HOST=0.0.0.0 to share it deliberately.
  host: process.env.SPEAKUP_HOST || "127.0.0.1",
  trustProxyTls: String(process.env.SPEAKUP_BEHIND_TLS || "").toLowerCase() === "true",
  dataFilePath: process.env.SPEAKUP_DATA_FILE || path.join(__dirname, "..", "data", "submissions.json"),
  userFilePath: process.env.SPEAKUP_USER_FILE || path.join(__dirname, "..", "data", "users.json"),

  // Appreciation lives in its own store: it names a recipient, whereas a
  // complaint must never name its author. Keeping them apart makes it far
  // harder for a query written for one to leak the other.
  appreciationFilePath: process.env.SPEAKUP_APPRECIATION_FILE || path.join(__dirname, "..", "data", "appreciations.json"),

  // SQLite: a single file inside the project. No server, no cloud, no account.
  // Backing it up is copying one file.
  databaseFile: process.env.SPEAKUP_DB_FILE || path.join(__dirname, "..", "data", "speakup.db"),

  // How long a resolved case is kept before npm run purge deletes it. 0
  // disables. Data no longer held cannot be leaked or subpoenaed, which for a
  // whistleblowing tool protects the reporter more than retention does.
  retentionDays: Number(process.env.SPEAKUP_RETENTION_DAYS || 0),

  // Append-only audit trail. A file, not a table: nothing in the running app
  // can rewrite it, and it is never served over HTTP.
  auditFile: process.env.SPEAKUP_AUDIT_FILE || path.join(__dirname, "..", "data", "audit.log"),

  // Email verification on registration. Turned off by default: with no SMTP
  // configured it only added a step that had to be worked around.
  requireVerification: String(process.env.SPEAKUP_REQUIRE_VERIFICATION || "false").toLowerCase() === "true",

  // Bootstrap owners. These are approved automatically so there is always
  // someone able to approve the first registrations.
  adminEmails: parseAdminEmails(process.env.SPEAKUP_ADMIN_EMAILS),

  // Only these domains may register at all. With autoApprove on, a verified
  // address from one of these domains is sufficient for dashboard access at the
  // defaultRole level; sensitive categories remain restricted by role.
  adminDomains: parseList(process.env.SPEAKUP_ADMIN_DOMAINS, DEFAULT_ADMIN_DOMAINS),

  verificationTtlMinutes: Number(process.env.SPEAKUP_VERIFICATION_TTL_MINUTES || 15),

  // How long a reporter may edit their own complaint after submitting. Short by
  // design: once leadership has read and acted on a report, letting the text
  // change underneath them would break the audit trail.
  editWindowMinutes: Number(process.env.SPEAKUP_EDIT_WINDOW_MINUTES || 30),

  // Anyone with a verified corporate address gets in automatically. Set to
  // "false" to put registrations back into an owner approval queue.
  autoApprove: String(process.env.SPEAKUP_AUTO_APPROVE || "true").toLowerCase() !== "false",

  // Role granted on self-registration. "staff" reads complaints but not the
  // sensitive categories, which stay with owners and reviewers.
  defaultRole: process.env.SPEAKUP_DEFAULT_ROLE || "staff",

  // Outbound email, used only for dashboard accounts — never to contact a
  // reporter, who has no address on file by design.
  //   SPEAKUP_SMTP_URL=smtps://user:pass@smtp.gmail.com:465
  smtpUrl: process.env.SPEAKUP_SMTP_URL || "",
  mailFrom: process.env.SPEAKUP_MAIL_FROM || "SpeakUp <noreply@localhost>",
  smtpConfigured: Boolean(process.env.SPEAKUP_SMTP_URL),

  // Outbound webhooks for HRIS/ticketing. Generic on purpose: coding to one
  // vendor guesses wrong for the others.
  webhookUrl: process.env.SPEAKUP_WEBHOOK_URL || "",
  webhookSecret: process.env.SPEAKUP_WEBHOOK_SECRET || "",
  webhookEvents: (process.env.SPEAKUP_WEBHOOK_EVENTS || "")
    .split(",").map((e) => e.trim()).filter(Boolean),
  webhookTimeoutMs: Number(process.env.SPEAKUP_WEBHOOK_TIMEOUT_MS || 5000),

  // Local HTTPS. Point these at a cert to serve TLS directly; behind a proxy
  // that terminates TLS (Render, nginx) leave them unset.
  tlsKeyFile: process.env.SPEAKUP_TLS_KEY || "",
  tlsCertFile: process.env.SPEAKUP_TLS_CERT || "",
  authSecret: resolveAuthSecret(nodeEnv),
  tokenTtlHours: Number(process.env.SPEAKUP_TOKEN_TTL_HOURS || 12),
  // "*" is a development convenience. In production an explicit origin (or
  // same-origin, the default here) stops any website from calling this API
  // with a token it has managed to obtain.
  corsOrigin: process.env.SPEAKUP_CORS_ORIGIN || (nodeEnv === "production" ? "" : "*"),
  rateLimit: {
    authWindowMs: Number(process.env.SPEAKUP_AUTH_RATE_WINDOW_MS || 15 * 60 * 1000),
    authMaxRequests: Number(process.env.SPEAKUP_AUTH_RATE_MAX || 10),
    submissionWindowMs: Number(process.env.SPEAKUP_SUBMISSION_RATE_WINDOW_MS || 15 * 60 * 1000),
    submissionMaxRequests: Number(process.env.SPEAKUP_SUBMISSION_RATE_MAX || 5)
  }
};
