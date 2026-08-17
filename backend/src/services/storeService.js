const crypto = require("crypto");
const db = require("./db");

/**
 * Submission storage, backed by SQLite.
 *
 * The JSON version this replaces re-read and re-wrote the whole file for every
 * change, and needed a hand-written promise chain so concurrent submissions did
 * not overwrite each other. SQLite in WAL mode gives both properties for free.
 *
 * Messages live in their own table but are always read with their submission,
 * so the shape the rest of the app sees is unchanged.
 */

function rowToSubmission(row, messages) {
  if (!row) { return null; }
  const value = db.toCamel(row);

  return {
    id: value.id,
    messageText: value.messageText,
    summary: value.summary,
    category: value.category,
    keywords: db.json(value.keywords, []),
    sentiment: value.sentiment,
    priority: value.priority,
    priorityScore: value.priorityScore,
    priorityLabel: value.priorityLabel,
    priorityColour: value.priorityColour,
    priorityReason: value.priorityReason,
    priorityTerms: db.json(value.priorityTerms, []),
    sla: value.sla,
    status: value.status,
    statusNote: value.statusNote || undefined,
    department: value.department,
    region: value.region,
    channel: value.channel,
    quarantined: Boolean(value.quarantined),
    flags: {
      spam: Boolean(value.flagSpam),
      urgent: Boolean(value.flagUrgent),
      sensitive: Boolean(value.flagSensitive)
    },
    metadata: { browserLocale: value.browserLocale || "unknown" },
    accessCodeHash: value.accessCodeHash,
    escalated: Boolean(value.escalated),
    escalatedTo: value.escalatedTo || null,
    escalatedBy: value.escalatedBy || null,
    escalatedAt: value.escalatedAt || null,
    escalationNote: value.escalationNote || null,
    mergedInto: value.mergedInto || null,
    mergedBy: value.mergedBy || null,
    mergedAt: value.mergedAt || null,
    assignedTo: value.assignedTo || null,
    assignedBy: value.assignedBy || null,
    assignedAt: value.assignedAt || null,
    dueAt: value.dueAt || null,
    editedAt: value.editedAt || undefined,
    editCount: value.editCount || 0,
    messages: messages || [],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function messagesFor(id) {
  return db.get()
    .prepare("SELECT * FROM messages WHERE submission_id = ? ORDER BY created_at ASC")
    .all(id)
    .map((row) => {
      const value = db.toCamel(row);
      return {
        id: value.id,
        authorType: value.authorType,
        messageText: value.messageText,
        createdAt: value.createdAt
      };
    });
}

async function listSubmissions() {
  const rows = db.get().prepare("SELECT * FROM submissions ORDER BY created_at DESC").all();
  // One query for every thread rather than one per row.
  const threads = {};
  db.get().prepare("SELECT * FROM messages ORDER BY created_at ASC").all().forEach((row) => {
    const value = db.toCamel(row);
    (threads[value.submissionId] = threads[value.submissionId] || []).push({
      id: value.id,
      authorType: value.authorType,
      messageText: value.messageText,
      createdAt: value.createdAt
    });
  });
  return rows.map((row) => rowToSubmission(row, threads[row.id] || []));
}

async function getSubmissionById(id) {
  const row = db.get().prepare("SELECT * FROM submissions WHERE id = ?").get(String(id || "").trim());
  return row ? rowToSubmission(row, messagesFor(row.id)) : null;
}

async function createSubmission(submission) {
  db.get().prepare(`
    INSERT INTO submissions (
      id, message_text, summary, category, keywords, sentiment,
      priority, priority_score, priority_label, priority_colour,
      priority_reason, priority_terms, sla, status, status_note,
      department, region, channel, quarantined,
      flag_spam, flag_urgent, flag_sensitive, browser_locale,
      access_code_hash, escalated, escalated_to, escalated_by, escalated_at,
      escalation_note, merged_into, merged_by, merged_at,
      assigned_to, assigned_by, assigned_at, due_at,
      edited_at, edit_count, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    submission.id, submission.messageText, submission.summary, submission.category,
    JSON.stringify(submission.keywords || []), submission.sentiment,
    submission.priority, submission.priorityScore || 0,
    submission.priorityLabel || null, submission.priorityColour || null,
    submission.priorityReason || null, JSON.stringify(submission.priorityTerms || []),
    submission.sla || null, submission.status || "open", submission.statusNote || null,
    submission.department, submission.region, submission.channel,
    submission.quarantined ? 1 : 0,
    submission.flags?.spam ? 1 : 0, submission.flags?.urgent ? 1 : 0, submission.flags?.sensitive ? 1 : 0,
    submission.metadata?.browserLocale || "unknown",
    submission.accessCodeHash,
    submission.escalated ? 1 : 0, submission.escalatedTo || null,
    submission.escalatedBy || null, submission.escalatedAt || null,
    submission.escalationNote || null,
    submission.mergedInto || null, submission.mergedBy || null, submission.mergedAt || null,
    submission.assignedTo || null, submission.assignedBy || null,
    submission.assignedAt || null, submission.dueAt || null,
    submission.editedAt || null, submission.editCount || 0,
    submission.createdAt, submission.updatedAt
  );

  (submission.messages || []).forEach((message) => appendMessageRow(submission.id, message));
  return getSubmissionById(submission.id);
}

function appendMessageRow(submissionId, message) {
  db.get().prepare(
    "INSERT INTO messages (id, submission_id, author_type, message_text, created_at) VALUES (?,?,?,?,?)"
  ).run(
    message.id || `msg-${crypto.randomUUID()}`,
    submissionId,
    message.authorType,
    message.messageText,
    message.createdAt || new Date().toISOString()
  );
}

/**
 * Kept updater-shaped so callers written against the JSON store still work.
 * The read and the write run inside one transaction, so a concurrent update
 * cannot land between them.
 */
async function updateSubmission(submissionId, updater) {
  const id = String(submissionId || "").trim();
  const database = db.get();

  const existing = await getSubmissionById(id);
  if (!existing) { return null; }

  const next = updater(existing);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      UPDATE submissions SET
        message_text = ?, summary = ?, category = ?, keywords = ?, sentiment = ?,
        priority = ?, priority_score = ?, priority_label = ?, priority_colour = ?,
        priority_reason = ?, priority_terms = ?, sla = ?,
        status = ?, status_note = ?, department = ?, region = ?, channel = ?,
        quarantined = ?, flag_spam = ?, flag_urgent = ?, flag_sensitive = ?,
        escalated = ?, escalated_to = ?, escalated_by = ?, escalated_at = ?,
        escalation_note = ?, merged_into = ?, merged_by = ?, merged_at = ?,
        assigned_to = ?, assigned_by = ?, assigned_at = ?,
        due_at = ?, edited_at = ?, edit_count = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.messageText, next.summary, next.category,
      JSON.stringify(next.keywords || []), next.sentiment,
      next.priority, next.priorityScore || 0, next.priorityLabel || null,
      next.priorityColour || null, next.priorityReason || null,
      JSON.stringify(next.priorityTerms || []), next.sla || null,
      next.status, next.statusNote || null,
      next.department, next.region, next.channel,
      next.quarantined ? 1 : 0,
      next.flags?.spam ? 1 : 0, next.flags?.urgent ? 1 : 0, next.flags?.sensitive ? 1 : 0,
      next.escalated ? 1 : 0, next.escalatedTo || null, next.escalatedBy || null,
      next.escalatedAt || null, next.escalationNote || null,
      next.mergedInto || null, next.mergedBy || null, next.mergedAt || null,
      next.assignedTo || null, next.assignedBy || null,
      next.assignedAt || null, next.dueAt || null,
      next.editedAt || null, next.editCount || 0,
      next.updatedAt || new Date().toISOString(),
      id
    );

    // Messages are replaced wholesale: callers hand back the full array, and
    // diffing it would be more code for no benefit at this size.
    const before = existing.messages || [];
    const after = next.messages || [];
    if (after.length !== before.length) {
      database.prepare("DELETE FROM messages WHERE submission_id = ?").run(id);
      after.forEach((message) => appendMessageRow(id, message));
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return getSubmissionById(id);
}

function countSubmissions() {
  return db.get().prepare("SELECT COUNT(*) AS n FROM submissions").get().n;
}

module.exports = {
  listSubmissions,
  createSubmission,
  updateSubmission,
  getSubmissionById,
  countSubmissions
};
