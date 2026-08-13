const { createHttpError } = require("./errorMiddleware");

function createRateLimiter(options) {
  const entries = new Map();
  const windowMs = Number(options.windowMs || 60000);
  const maxRequests = Number(options.maxRequests || 10);
  const message = options.message || "Too many requests";
  const keySelector = options.keySelector || ((request) => request.ip || request.socket?.remoteAddress || "unknown");

  return function rateLimitMiddleware(request, response, next) {
    const now = Date.now();
    const key = keySelector(request);
    const existing = entries.get(key);

    if (!existing || existing.resetAt <= now) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      response.setHeader("X-RateLimit-Limit", String(maxRequests));
      response.setHeader("X-RateLimit-Remaining", String(maxRequests - 1));
      return next();
    }

    existing.count += 1;
    response.setHeader("X-RateLimit-Limit", String(maxRequests));
    response.setHeader("X-RateLimit-Remaining", String(Math.max(maxRequests - existing.count, 0)));
    response.setHeader("X-RateLimit-Reset", String(existing.resetAt));

    if (existing.count > maxRequests) {
      return next(createHttpError(429, message));
    }

    return next();
  };
}

module.exports = {
  createRateLimiter
};