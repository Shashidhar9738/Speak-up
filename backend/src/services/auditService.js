const fs = require("fs");
const path = require("path");
const config = require("../config");

/**
 * Audit trail.
 *
 * Deliberately a plain append-only text file, NOT a database table and NOT
 * exposed through any endpoint. Two reasons:
 *
 *   1. Nothing in the running app can rewrite history. A table is editable by
 *      whatever can reach the database; a file opened in append mode is not
 *      changed by the application at all.
 *   2. An audit trail readable through the dashboard tells a curious admin who
 *      else has been reading which complaints — which is surveillance, not
 *      accountability. It is for whoever administers the server.
 *
 * One JSON object per line so it can be grepped by eye or parsed by machine.
 *
 * Read it with:  type backend\\data\\audit.log      (Windows)
 *                tail -f backend/data/audit.log     (Unix)
 */

let stream = null;

function open() {
  if (stream) { return stream; }
  const file = config.auditFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // "a" — append only. Existing lines are never seeked to or overwritten.
  stream = fs.createWriteStream(file, { flags: "a" });
  return stream;
}

/**
 * @param action  short verb, e.g. "submission.read"
 * @param actor   who did it — an email, or "anonymous"
 * @param detail  small object; must never contain complaint text or a password
 */
function record(action, actor, detail) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action,
      actor: actor || "anonymous",
      ...(detail || {})
    });
    open().write(line + "\n");
  } catch (error) {
    // Auditing must never break the request it is describing.
    console.warn("[speakup] audit write failed:", error.message);
  }
}

// Reading a complaint is the event that matters most: it is the moment someone
// could learn something about a colleague.
function recordRead(request, ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) { return; }
  record("submission.read", request.user && request.user.email, {
    role: request.user && request.user.role,
    count: list.length,
    ids: list.slice(0, 25)
  });
}

function close() {
  if (stream) { stream.end(); stream = null; }
}

module.exports = { record, recordRead, close };
