const { verifyToken } = require("../services/tokenService");
const { canSignIn, ACCESS_HELP } = require("../services/userService");
const { createHttpError } = require("./errorMiddleware");

async function requireAdmin(request, response, next) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const result = verifyToken(token);

  // Auth failures go through next() like every other error so they carry the
  // one response shape the rest of the API uses: a human message in `error`,
  // the machine-readable cause in `details.reason`.
  if (!result.valid) {
    return next(createHttpError(401, "Your session is not valid. Please sign in again.", {
      reason: result.reason
    }));
  }

  // Account state is re-checked on every request, not just at login: a token
  // issued before an account was revoked (or before an owner rejected it) must
  // stop working immediately rather than lasting until it expires.
  const verdict = await canSignIn(result.user.email);
  if (!verdict.allowed) {
    return next(createHttpError(403, ACCESS_HELP[verdict.reason] || "This account cannot access SpeakUp.", {
      reason: verdict.reason
    }));
  }

  request.user = { ...result.user, role: verdict.role, departments: verdict.departments || [] };
  return next();
}

module.exports = {
  requireAdmin
};
