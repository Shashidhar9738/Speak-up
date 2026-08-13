const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

/**
 * Password hashing.
 *
 * scrypt is used rather than a plain SHA hash: it is deliberately slow and
 * memory-hard, so a stolen user file cannot be brute forced at GPU speed.
 * Node ships it, so this adds no dependency.
 *
 * Stored format:  scrypt$N$r$p$<salt-b64>$<hash-b64>
 * The parameters travel with the hash, so they can be raised later without
 * invalidating existing passwords.
 */

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

const MIN_LENGTH = 10;
// Rejecting the handful of passwords everyone actually picks does more good
// than any composition rule ("must contain a symbol") ever does.
const COMMON = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwerty123", "letmein123", "welcome123", "admin12345", "changeme1",
  "iloveyou1", "sunshine1", "princess1", "football1", "speakup123"
]);

function validatePassword(password, email) {
  const value = String(password || "");

  if (value.length < MIN_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_LENGTH} characters` };
  }
  if (value.length > 200) {
    return { ok: false, reason: "Password must be 200 characters or fewer" };
  }
  if (COMMON.has(value.toLowerCase())) {
    return { ok: false, reason: "That password is too common. Please choose another." };
  }
  if (email) {
    const local = String(email).split("@")[0].toLowerCase();
    if (local.length > 2 && value.toLowerCase().includes(local)) {
      return { ok: false, reason: "Password must not contain your email address" };
    }
  }
  if (/^(.)\1+$/.test(value)) {
    return { ok: false, reason: "Password must not be a single repeated character" };
  }

  return { ok: true };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p
  });
  return [
    "scrypt", PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64")
  ].join("$");
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") {
    // Still spend the time: returning early on "no password set" would let an
    // attacker distinguish real accounts from absent ones by response timing.
    await scrypt(String(password), crypto.randomBytes(16), PARAMS.keylen, {
      N: PARAMS.N, r: PARAMS.r, p: PARAMS.p
    });
    return false;
  }

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");

  let derived;
  try {
    derived = await scrypt(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p)
    });
  } catch (error) {
    return false;
  }

  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/**
 * A readable generated password, for seeding accounts. Four words plus digits
 * beats a random string nobody can type — length carries the entropy.
 */
const WORDS = [
  "harbor", "meadow", "cinder", "lantern", "quartz", "marble", "thicket", "willow",
  "copper", "ember", "falcon", "gravel", "hollow", "indigo", "juniper", "kettle",
  "lumber", "mantle", "nectar", "onyx", "pebble", "quiver", "ripple", "saffron",
  "timber", "umber", "velvet", "walnut", "yonder", "zephyr", "basalt", "cobalt"
];

function generatePassword() {
  const picked = [];
  for (let i = 0; i < 3; i += 1) {
    picked.push(WORDS[crypto.randomInt(0, WORDS.length)]);
  }
  return picked.join("-") + "-" + crypto.randomInt(100, 1000);
}

module.exports = {
  MIN_LENGTH,
  validatePassword,
  hashPassword,
  verifyPassword,
  generatePassword
};
