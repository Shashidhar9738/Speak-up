const { verifyToken } = require("../services/tokenService");
const { canSignIn } = require("../services/userService");

async function requireAdmin(request, response, next) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const result = verifyToken(token);

  if (!result.valid) {
    return response.status(401).json({ error: "Unauthorized", reason: result.reason });
  }

  // Account state is re-checked on every request, not just at login: a token
  // issued before an account was revoked (or before an owner rejected it) must
  // stop working immediately rather than lasting until it expires.
  const verdict = await canSignIn(result.user.email);
  if (!verdict.allowed) {
    return response.status(403).json({ error: "Forbidden", reason: verdict.reason });
  }

  request.user = { ...result.user, role: verdict.role, departments: verdict.departments || [] };
  return next();
}

module.exports = {
  requireAdmin
};
