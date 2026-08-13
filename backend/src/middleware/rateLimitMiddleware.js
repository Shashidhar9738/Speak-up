const db = require("../services/db");
const { createHttpError } = require("./errorMiddleware");

/**
 * Rate limiting, persisted to SQLite.
 *
 * The in-memory version this replaces reset on every restart, so anyone who
 * could trigger a restart — or simply wait for a free-tier host to recycle the
 * process — got a fresh allowance. Counters now survive, and are shared if the
 * app ever runs more than one process against the same database.
 */

function createRateLimiter(options) {
  const windowMs = Number(options.windowMs || 60000);
  const maxRequests = Number(options.maxRequests || 10);
  const message = options.message || "Too many requests";
  const name = options.name || "default";
  const keySelector = options.keySelector ||
    ((request) => request.ip || request.socket?.remoteAddress || "unknown");

  return function rateLimitMiddleware(request, response, next) {
    const now = Date.now();
    const bucket = `${name}:${keySelector(request)}`;
    const database = db.get();

    let count;
    let resetAt;

    try {
      const existing = database.prepare("SELECT count, reset_at FROM rate_limits WHERE bucket = ?").get(bucket);

      if (!existing || existing.reset_at <= now) {
        resetAt = now + windowMs;
        count = 1;
        database.prepare(
          "INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?,?,?) " +
          "ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at"
        ).run(bucket, count, resetAt);
      } else {
        count = existing.count + 1;
        resetAt = existing.reset_at;
        database.prepare("UPDATE rate_limits SET count = ? WHERE bucket = ?").run(count, bucket);
      }
    } catch (error) {
      // A limiter that fails closed would take the whole app down with the
      // database. Log and allow — availability matters more than a precise
      // count here.
      console.warn("[speakup] rate limit check failed, allowing request:", error.message);
      return next();
    }

    response.setHeader("X-RateLimit-Limit", String(maxRequests));
    response.setHeader("X-RateLimit-Remaining", String(Math.max(maxRequests - count, 0)));
    response.setHeader("X-RateLimit-Reset", String(resetAt));

    if (count > maxRequests) {
      return next(createHttpError(429, message));
    }
    return next();
  };
}

// Expired buckets would otherwise accumulate forever.
function sweep() {
  try {
    db.get().prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(Date.now());
  } catch (error) {
    /* the table may not exist yet on first boot */
  }
}

module.exports = { createRateLimiter, sweep };
