const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config");
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
let mutationChain = Promise.resolve();

function withLock(operation) {
  const result = mutationChain.then(operation, operation);
  mutationChain = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureStore() {
  await fs.mkdir(path.dirname(config.userFilePath), { recursive: true });
  try {
    await fs.access(config.userFilePath);
  } catch {
    await fs.writeFile(config.userFilePath, JSON.stringify({ users: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const content = await fs.readFile(config.userFilePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(content || "{}");
  } catch (error) {
    throw new Error(`User store at ${config.userFilePath} is not valid JSON`);
  }
  return { users: Array.isArray(parsed.users) ? parsed.users : [] };
}

async function writeStore(store) {
  await ensureStore();
  const payload = JSON.stringify({ users: store.users || [] }, null, 2);
  const tempPath = `${config.userFilePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, config.userFilePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

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
  const store = await readStore();
  const target = normalizeEmail(email);
  return store.users.find((user) => user.email === target) || null;
}

/**
 * Bootstrap owners are materialized on demand so a fresh install always has an
 * account that can approve others, without seeding secrets into the repo.
 */
async function ensureBootstrapOwner(email) {
  const target = normalizeEmail(email);
  if (!isBootstrapOwner(target)) {
    return null;
  }

  return withLock(async () => {
    const store = await readStore();
    const existing = store.users.find((user) => user.email === target);
    if (existing) {
      // Keep bootstrap accounts usable even if they were revoked by mistake.
      if (existing.status !== STATUS.APPROVED || existing.role !== ROLES.OWNER) {
        existing.status = STATUS.APPROVED;
        existing.role = ROLES.OWNER;
        existing.updatedAt = new Date().toISOString();
        await writeStore(store);
      }
      return existing;
    }

    const owner = {
      email: target,
      role: ROLES.OWNER,
      status: STATUS.APPROVED,
      source: "bootstrap",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvedBy: "config",
      approvedAt: new Date().toISOString()
    };
    store.users.push(owner);
    await writeStore(store);
    return owner;
  });
}

async function registerUser({ email, fullName, reason, passwordHash }) {
  const target = normalizeEmail(email);

  return withLock(async () => {
    const store = await readStore();
    const existing = store.users.find((user) => user.email === target);
    const code = createVerificationCode();
    const now = new Date().toISOString();
    const expiresAt = Date.now() + config.verificationTtlMinutes * 60 * 1000;

    if (existing) {
      // Re-registering an approved or rejected account must not reset it —
      // that would let anyone bounce a rejected account back into the queue.
      if (existing.status === STATUS.APPROVED) {
        return { user: existing, code: null, alreadyApproved: true };
      }
      if (existing.status === STATUS.REJECTED || existing.status === STATUS.REVOKED) {
        return { user: existing, code: null, blocked: true };
      }

      existing.verificationCodeHash = hashCode(code);
      existing.verificationExpiresAt = expiresAt;
      existing.verificationAttempts = 0;
      existing.status = STATUS.PENDING_VERIFICATION;
      existing.updatedAt = now;
      if (fullName) { existing.fullName = fullName; }
      if (reason) { existing.reason = reason; }
      if (passwordHash) { existing.passwordHash = passwordHash; }
      await writeStore(store);
      return { user: existing, code };
    }

    const user = {
      email: target,
      fullName: fullName || "",
      reason: reason || "",
      role: DEFAULT_ROLE,
      departments: [],
      passwordHash: passwordHash || null,
      status: STATUS.PENDING_VERIFICATION,
      source: "registration",
      createdAt: now,
      updatedAt: now,
      verificationCodeHash: hashCode(code),
      verificationExpiresAt: expiresAt,
      verificationAttempts: 0
    };
    store.users.push(user);
    await writeStore(store);
    return { user, code };
  });
}

async function verifyUser({ email, code }) {
  const target = normalizeEmail(email);

  return withLock(async () => {
    const store = await readStore();
    const user = store.users.find((item) => item.email === target);

    if (!user || user.status !== STATUS.PENDING_VERIFICATION) {
      return { error: "No pending registration for that address" };
    }

    if (!user.verificationExpiresAt || Date.now() > user.verificationExpiresAt) {
      return { error: "Verification code expired. Please register again." };
    }

    // Cap attempts so a 6-digit code cannot simply be brute forced.
    if ((user.verificationAttempts || 0) >= 5) {
      return { error: "Too many incorrect attempts. Please register again." };
    }

    if (!codesMatch(code, user.verificationCodeHash)) {
      user.verificationAttempts = (user.verificationAttempts || 0) + 1;
      user.updatedAt = new Date().toISOString();
      await writeStore(store);
      return { error: "Incorrect verification code" };
    }

    // With autoApprove on, a verified corporate address is enough — no owner
    // sign-off. Turn SPEAKUP_AUTO_APPROVE=false to restore the queue.
    user.status = config.autoApprove ? STATUS.APPROVED : STATUS.PENDING_APPROVAL;
    user.emailVerifiedAt = new Date().toISOString();
    if (config.autoApprove) {
      user.approvedBy = "auto (verified corporate domain)";
      user.approvedAt = user.emailVerifiedAt;
    }
    user.updatedAt = user.emailVerifiedAt;
    delete user.verificationCodeHash;
    delete user.verificationExpiresAt;
    delete user.verificationAttempts;
    await writeStore(store);
    return { user };
  });
}

async function setUserStatus({ email, status, actorEmail, role, departments }) {
  const target = normalizeEmail(email);

  return withLock(async () => {
    const store = await readStore();
    const user = store.users.find((item) => item.email === target);
    if (!user) {
      return null;
    }

    user.status = status;
    user.updatedAt = new Date().toISOString();
    if (role) {
      user.role = role;
    }
    if (departments) {
      user.departments = departments;
    }
    if (status === STATUS.APPROVED) {
      user.approvedBy = actorEmail;
      user.approvedAt = user.updatedAt;
    }
    await writeStore(store);
    return user;
  });
}

async function setPassword(email, plainPassword) {
  const target = normalizeEmail(email);
  const passwordHash = await hashPassword(plainPassword);

  return withLock(async () => {
    const store = await readStore();
    const user = store.users.find((item) => item.email === target);
    if (!user) { return null; }
    user.passwordHash = passwordHash;
    user.passwordSetAt = new Date().toISOString();
    user.updatedAt = user.passwordSetAt;
    await writeStore(store);
    return user;
  });
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
  const store = await readStore();
  return store.users
    .slice()
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
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
