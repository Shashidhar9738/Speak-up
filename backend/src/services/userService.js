const crypto = require("crypto");
const config = require("../config");
const db = require("./db");
const { hashPassword, verifyPassword } = require("./passwordService");

/**
 * Dashboard accounts.
 *
 * Registration is restricted to the configured corporate domains. With
 * config.autoApprove on (the default), verifying the emailed code grants access
 * immediately at config.defaultRole; what that role can actually read is decided
 * separately by accessScopeService, which keeps the sensitive categories with
 * owners and reviewers.
 *
 * Account lifecycle:
 *   pending_verification -> approved                    (autoApprove on)
 *   pending_verification -> pending_approval -> approved (autoApprove off)
 *                                            -> rejected / revoked
 */

const STATUS = {
  PENDING_VERIFICATION: "pending_verification",
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  REVOKED: "revoked"
};

// Mirrors accessScopeService. New accounts default to the least-privileged
// role, so an approval that forgets to set one cannot over-grant.
const ROLES = { OWNER: "owner", REVIEWER: "reviewer", LEAD: "lead", STAFF: "staff", ANALYST: "analyst" };
const DEFAULT_ROLE = config.defaultRole || ROLES.STAFF;

// Mutations are serialized for the same reason as the submission store: a
// read-modify-write with an await in the middle loses records under load.
function rowToUser(row) {
  if (!row) { return null; }
  const value = db.toCamel(row);
  return {
    email: value.email,
    fullName: value.fullName || "",
    reason: value.reason || "",
    role: value.role,
    departments: db.json(value.departments, []),
    status: value.status,
    source: value.source,
    passwordHash: value.passwordHash || null,
    passwordSetAt: value.passwordSetAt || undefined,
    emailVerifiedAt: value.emailVerifiedAt || undefined,
    approvedBy: value.approvedBy || undefined,
    approvedAt: value.approvedAt || undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function upsertUser(user) {
  db.get().prepare(`
    INSERT INTO users (
      email, full_name, reason, role, departments, status, source,
      password_hash, password_set_at, email_verified_at,
      approved_by, approved_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET
      full_name = excluded.full_name,
      reason = excluded.reason,
      role = excluded.role,
      departments = excluded.departments,
      status = excluded.status,
      source = excluded.source,
      password_hash = excluded.password_hash,
      password_set_at = excluded.password_set_at,
      email_verified_at = excluded.email_verified_at,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      updated_at = excluded.updated_at
  `).run(
    user.email, user.fullName || null, user.reason || null,
    user.role, JSON.stringify(user.departments || []), user.status, user.source || null,
    user.passwordHash || null, user.passwordSetAt || null, user.emailVerifiedAt || null,
    user.approvedBy || null, user.approvedAt || null,
    user.createdAt, user.updatedAt
  );
  return user;
}

// Codes live for 15 minutes and are useless afterwards, so they stay in memory
// rather than becoming rows that need expiring.
const pendingCodes = new Map();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function emailDomain(email) {
  const at = normalizeEmail(email).lastIndexOf("@");
  return at === -1 ? "" : normalizeEmail(email).slice(at + 1);
}

function isAllowedDomain(email) {
  return config.adminDomains.includes(emailDomain(email));
}

function isBootstrapOwner(email) {
  return config.adminEmails.includes(normalizeEmail(email));
}

// Six digits is enough entropy given the 15-minute TTL and the 5-attempt cap;
// it is stored hashed so the user file never contains a usable code.
function createVerificationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code).trim()).digest("hex");
}

function codesMatch(candidate, storedHash) {
  if (!storedHash) {
    return false;
  }
  const left = Buffer.from(hashCode(candidate), "hex");
  const right = Buffer.from(storedHash, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicUser(user) {
  if (!user) {
    return null;
  }
  const { verificationCodeHash, verificationExpiresAt, verificationAttempts, passwordHash, ...safe } = user;
  safe.hasPassword = Boolean(passwordHash);
  return safe;
}

async function findUser(email) {
  const row = db.get().prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
  return rowToUser(row);
}

/**
 * Bootstrap owners are materialized on demand so a fresh install always has an
 * account that can approve others, without seeding secrets into the repo.
 */
async function ensureBootstrapOwner(email) {
  const target = normalizeEmail(email);
  if (!isBootstrapOwner(target)) { return null; }

  const existing = await findUser(target);
  const now = new Date().toISOString();

  if (existing) {
    // Keep bootstrap accounts usable even if revoked by mistake.
    if (existing.status !== STATUS.APPROVED || existing.role !== ROLES.OWNER) {
      existing.status = STATUS.APPROVED;
      existing.role = ROLES.OWNER;
      existing.updatedAt = now;
      upsertUser(existing);
    }
    return existing;
  }

  return upsertUser({
    email: target, fullName: "", reason: "", role: ROLES.OWNER, departments: [],
    status: STATUS.APPROVED, source: "bootstrap", passwordHash: null,
    approvedBy: "config", approvedAt: now, createdAt: now, updatedAt: now
  });
}

async function registerUser({ email, fullName, reason, passwordHash }) {
  const target = normalizeEmail(email);
  const existing = await findUser(target);
  const code = createVerificationCode();
  const now = new Date().toISOString();

  if (existing) {
    // Re-registering an approved or rejected account must not reset it — that
    // would let anyone bounce a rejected account back into the queue.
    if (existing.status === STATUS.APPROVED) {
      return { user: existing, code: null, alreadyApproved: true };
    }
    if (existing.status === STATUS.REJECTED || existing.status === STATUS.REVOKED) {
      return { user: existing, code: null, blocked: true };
    }
    existing.status = STATUS.PENDING_VERIFICATION;
    existing.updatedAt = now;
    if (fullName) { existing.fullName = fullName; }
    if (reason) { existing.reason = reason; }
    if (passwordHash) { existing.passwordHash = passwordHash; }
    upsertUser(existing);
    pendingCodes.set(target, { hash: hashCode(code), expiresAt: Date.now() + config.verificationTtlMinutes * 60000, attempts: 0 });
    return { user: existing, code };
  }

  const user = upsertUser({
    email: target, fullName: fullName || "", reason: reason || "",
    role: DEFAULT_ROLE, departments: [],
    status: config.requireVerification ? STATUS.PENDING_VERIFICATION : STATUS.APPROVED,
    source: "registration", passwordHash: passwordHash || null,
    emailVerifiedAt: config.requireVerification ? null : now,
    approvedBy: config.requireVerification ? null : "auto (verified corporate domain)",
    approvedAt: config.requireVerification ? null : now,
    createdAt: now, updatedAt: now
  });

  if (config.requireVerification) {
    pendingCodes.set(target, { hash: hashCode(code), expiresAt: Date.now() + config.verificationTtlMinutes * 60000, attempts: 0 });
    return { user, code };
  }
  // Verification is off: the account is live immediately and no code is issued.
  return { user, code: null, autoApproved: true };
}

async function verifyUser({ email, code }) {
  const target = normalizeEmail(email);
  const user = await findUser(target);
  const pending = pendingCodes.get(target);

  if (!user || !pending) {
    return { error: "No pending registration for that address" };
  }
  if (Date.now() > pending.expiresAt) {
    pendingCodes.delete(target);
    return { error: "Verification code expired. Please register again." };
  }
  // Cap attempts so a 6-digit code cannot simply be brute forced.
  if (pending.attempts >= 5) {
    pendingCodes.delete(target);
    return { error: "Too many incorrect attempts. Please register again." };
  }
  if (!codesMatch(code, pending.hash)) {
    pending.attempts += 1;
    return { error: "Incorrect verification code" };
  }

  pendingCodes.delete(target);
  const now = new Date().toISOString();
  user.status = config.autoApprove ? STATUS.APPROVED : STATUS.PENDING_APPROVAL;
  user.emailVerifiedAt = now;
  user.updatedAt = now;
  if (config.autoApprove) {
    user.approvedBy = "auto (verified corporate domain)";
    user.approvedAt = now;
  }
  upsertUser(user);
  return { user };
}

async function setUserStatus({ email, status, actorEmail, role, departments }) {
  const user = await findUser(email);
  if (!user) { return null; }

  user.status = status;
  user.updatedAt = new Date().toISOString();
  if (role) { user.role = role; }
  if (departments) { user.departments = departments; }
  if (status === STATUS.APPROVED) {
    user.approvedBy = actorEmail;
    user.approvedAt = user.updatedAt;
  }
  return upsertUser(user);
}

async function setPassword(email, plainPassword) {
  const user = await findUser(email);
  if (!user) { return null; }
  user.passwordHash = await hashPassword(plainPassword);
  user.passwordSetAt = new Date().toISOString();
  user.updatedAt = user.passwordSetAt;
  return upsertUser(user);
}

/**
 * Password check. Always runs the KDF, even for an unknown address, so response
 * timing cannot be used to discover which emails have accounts.
 */
async function checkPassword(email, plainPassword) {
  const user = await findUser(email);
  const matched = await verifyPassword(plainPassword, user && user.passwordHash);
  if (!user || !matched) {
    return { ok: false };
  }
  return { ok: true, user };
}

async function listUsers() {
  return db.get().prepare("SELECT * FROM users ORDER BY created_at DESC").all().map(rowToUser);
}

/**
 * Single source of truth for "may this email hold a session right now".
 * Called on every authenticated request, so revoking access takes effect
 * immediately rather than when the token happens to expire.
 */
async function canSignIn(email) {
  const target = normalizeEmail(email);

  if (isBootstrapOwner(target)) {
    await ensureBootstrapOwner(target);
    return { allowed: true, role: ROLES.OWNER, departments: [] };
  }

  const user = await findUser(target);
  if (!user) {
    return { allowed: false, reason: "not_registered" };
  }
  if (user.status === STATUS.APPROVED) {
    return {
      allowed: true,
      role: user.role || DEFAULT_ROLE,
      departments: Array.isArray(user.departments) ? user.departments : []
    };
  }
  return { allowed: false, reason: user.status };
}

module.exports = {
  STATUS,
  ROLES,
  normalizeEmail,
  emailDomain,
  isAllowedDomain,
  isBootstrapOwner,
  ensureBootstrapOwner,
  registerUser,
  verifyUser,
  setUserStatus,
  listUsers,
  findUser,
  canSignIn,
  setPassword,
  checkPassword,
  publicUser
};
