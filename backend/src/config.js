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

  // With no SMTP configured the verification code cannot be emailed. In
  // development it is surfaced in the API response so the flow is testable;
  // in production that would hand anyone an account, so it is refused instead.
  smtpConfigured: Boolean(process.env.SPEAKUP_SMTP_URL),
  authSecret: resolveAuthSecret(nodeEnv),
  tokenTtlHours: Number(process.env.SPEAKUP_TOKEN_TTL_HOURS || 12),
  corsOrigin: process.env.SPEAKUP_CORS_ORIGIN || "*",
  rateLimit: {
    authWindowMs: Number(process.env.SPEAKUP_AUTH_RATE_WINDOW_MS || 15 * 60 * 1000),
    authMaxRequests: Number(process.env.SPEAKUP_AUTH_RATE_MAX || 10),
    submissionWindowMs: Number(process.env.SPEAKUP_SUBMISSION_RATE_WINDOW_MS || 15 * 60 * 1000),
    submissionMaxRequests: Number(process.env.SPEAKUP_SUBMISSION_RATE_MAX || 5)
  }
};
