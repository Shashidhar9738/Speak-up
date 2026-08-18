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

// Bump the bucket and read the result in a single statement. The CASE arms are
// the window rollover: an entry whose reset_at has passed starts again at 1 with
// a fresh window, anything else counts up and keeps the window it had.
// Parameters: bucket, resetAt, now, now, resetAt.
const COUNT_SQL =
  "INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?) " +
  "ON CONFLICT(bucket) DO UPDATE SET " +
  "  count    = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END, " +
  "  reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END " +
  "RETURNING count, reset_at";

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

    let count;
    let resetAt;

    try {
      // One statement, so the read and the write cannot be split. Counting with
      // a SELECT followed by an UPDATE let two processes sharing the database
      // both read the same count and both write count + 1, spending one request
      // of the allowance for two requests served — exactly the gap an attacker
      // widens by running requests in parallel. SQLite serializes the upsert,
      // and RETURNING hands back the values it settled on.
      const row = db.get().prepare(COUNT_SQL).get(bucket, now + windowMs, now, now, now + windowMs);
      count = row.count;
      resetAt = row.reset_at;
    } catch (error) {
      // A limiter that fails closed would take the whole app down with the
      // database. Log and allow — availability matters more than a precise
      // count here.
      console.warn("[speakup] rate limit check failed, allowing request:", error.message);
      return next();
    }

    // Seconds, not milliseconds: every client and proxy that reads these treats
    // the value as a UNIX timestamp in seconds, and a millisecond value reads as
    // a date tens of thousands of years out.
    response.setHeader("X-RateLimit-Limit", String(maxRequests));
    response.setHeader("X-RateLimit-Remaining", String(Math.max(maxRequests - count, 0)));
    response.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

    if (count > maxRequests) {
      // Retry-After is the header clients actually honour, and it is a delay in
      // seconds rather than a timestamp.
      response.setHeader("Retry-After", String(Math.max(Math.ceil((resetAt - now) / 1000), 1)));
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
