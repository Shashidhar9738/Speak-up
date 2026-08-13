const crypto = require("crypto");
const config = require("../config");

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", config.authSecret).update(payload).digest("base64url");
}

// Length-independent equality: timingSafeEqual throws on mismatched lengths, so
// compare digests of both sides rather than the raw signatures.
function signaturesMatch(candidate, expected) {
  const candidateDigest = crypto.createHash("sha256").update(String(candidate)).digest();
  const expectedDigest = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

function createToken(email) {
  const expiresAt = Date.now() + config.tokenTtlHours * 60 * 60 * 1000;
  const payload = JSON.stringify({ email, expiresAt });
  const encodedPayload = toBase64Url(payload);
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "Malformed token" };
  }

  // Exactly two segments: anything else is not a token we issued, and silently
  // ignoring trailing segments would let "<valid-token>.garbage" authenticate.
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "Malformed token" };
  }

  const [encodedPayload, signature] = parts;

  if (!signaturesMatch(signature, signPayload(encodedPayload))) {
    return { valid: false, reason: "Invalid signature" };
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (!payload.email || !payload.expiresAt) {
      return { valid: false, reason: "Invalid token payload" };
    }

    if (Date.now() > payload.expiresAt) {
      return { valid: false, reason: "Token expired" };
    }

    return {
      valid: true,
      user: {
        email: String(payload.email).toLowerCase(),
        expiresAt: payload.expiresAt
      }
    };
  } catch (error) {
    return { valid: false, reason: "Unreadable token payload" };
  }
}

module.exports = {
  createToken,
  verifyToken
};
