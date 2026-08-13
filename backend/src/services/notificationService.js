const crypto = require("crypto");
const db = require("./db");

/**
 * In-app notifications for reporters.
 *
 * A reporter has no email address — that is the point — so there is nothing to
 * send a message to. Instead a notice is written against the submission, and
 * the reporter sees it next time they open the tracking page with their access
 * code. Nothing is pushed anywhere, and no contact detail is ever needed.
 */

const KIND = {
  STATUS: "status",
  REPLY: "reply",
  RESOLVED: "resolved"
};

function create(submissionId, kind, title, body) {
  db.get().prepare(
    "INSERT INTO notifications (id, submission_id, kind, title, body, created_at) VALUES (?,?,?,?,?,?)"
  ).run(
    `ntf-${crypto.randomUUID()}`,
    submissionId,
    kind,
    title,
    body || null,
    new Date().toISOString()
  );
}

function forSubmission(submissionId) {
  return db.get()
    .prepare("SELECT * FROM notifications WHERE submission_id = ? ORDER BY created_at DESC")
    .all(String(submissionId || "").trim())
    .map((row) => {
      const value = db.toCamel(row);
      return {
        id: value.id,
        kind: value.kind,
        title: value.title,
        body: value.body || "",
        read: Boolean(value.readAt),
        createdAt: value.createdAt
      };
    });
}

function unreadCount(submissionId) {
  return db.get()
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE submission_id = ? AND read_at IS NULL")
    .get(String(submissionId || "").trim()).n;
}

// Called once the reporter has actually opened the thread, so an unread badge
// means "there is something here you have not seen".
function markRead(submissionId) {
  db.get().prepare(
    "UPDATE notifications SET read_at = ? WHERE submission_id = ? AND read_at IS NULL"
  ).run(new Date().toISOString(), String(submissionId || "").trim());
}

/**
 * Wording is written for the reporter, not the admin: they see "your report",
 * never an internal status code on its own.
 */
function announceStatus(submissionId, status, note) {
  const wording = {
    acknowledged: ["Your report has been picked up", "Someone in leadership has read it and is looking into it."],
    resolved: ["Your report has been marked resolved", "Leadership considers this closed. You can still reply if you disagree."],
    open: ["Your report was reopened", "It is back with leadership for another look."]
  }[status];

  if (!wording) { return; }
  create(submissionId, status === "resolved" ? KIND.RESOLVED : KIND.STATUS,
    wording[0], note ? `${wording[1]} Note: ${note}` : wording[1]);
}

function announceReply(submissionId) {
  create(submissionId, KIND.REPLY,
    "Leadership replied to your report",
    "Open the messages below to read it and respond.");
}

module.exports = { KIND, create, forSubmission, unreadCount, markRead, announceStatus, announceReply };
