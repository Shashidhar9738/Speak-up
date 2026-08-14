const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("../config");

/**
 * SQLite storage — one file inside the project, no server and no cloud.
 *
 * Uses node:sqlite, built into Node 22+, so this adds no dependency. It
 * replaces the JSON files, which re-parsed the whole dataset on every read and
 * needed a hand-written mutex to avoid losing records under concurrency.
 * SQLite gives both properties for free, and backing it up is copying one file.
 *
 * Tables
 * ------
 *   submissions    Anonymous complaints. NO column identifies the reporter; the
 *                  access code exists only as a SHA-256 hash, which is what
 *                  makes a report unlinkable to a person even with the file in
 *                  hand.
 *   messages       Two-way thread on a submission (admin <-> reporter).
 *   users          Dashboard accounts. Passwords are scrypt hashes.
 *   appreciations  Recognition. Names the RECIPIENT, and the nominator only if
 *                  they chose to be credited on the form.
 *   notifications  In-app notices for reporters, keyed by submission.
 *   rate_limits    Request counters. Persisted, so a limit can no longer be
 *                  bypassed by waiting for the process to restart.
 *
 * The audit trail is deliberately NOT a table — see auditService.
 */

let db = null;

function open() {
  if (db) { return db; }

  fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
  db = new DatabaseSync(config.databaseFile);

  // WAL lets reads proceed during a write, which is what makes concurrent
  // submissions safe without the mutex the JSON store needed.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  migrate();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id               TEXT PRIMARY KEY,
      message_text     TEXT NOT NULL,
      summary          TEXT NOT NULL,
      category         TEXT NOT NULL,
      keywords         TEXT NOT NULL DEFAULT '[]',
      sentiment        TEXT NOT NULL,
      priority         TEXT NOT NULL,
      priority_score   INTEGER NOT NULL DEFAULT 0,
      priority_label   TEXT,
      priority_colour  TEXT,
      priority_reason  TEXT,
      priority_terms   TEXT NOT NULL DEFAULT '[]',
      sla              TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      status_note      TEXT,
      department       TEXT NOT NULL DEFAULT 'Unspecified',
      region           TEXT NOT NULL DEFAULT 'Unspecified',
      channel          TEXT NOT NULL DEFAULT 'web',
      quarantined      INTEGER NOT NULL DEFAULT 0,
      flag_spam        INTEGER NOT NULL DEFAULT 0,
      flag_urgent      INTEGER NOT NULL DEFAULT 0,
      flag_sensitive   INTEGER NOT NULL DEFAULT 0,
      browser_locale   TEXT,
      access_code_hash TEXT NOT NULL,
      -- Escalation is a separate axis from status: a report can be escalated
      -- and still open, and un-escalating must not silently reopen it.
      escalated        INTEGER NOT NULL DEFAULT 0,
      escalated_to     TEXT,
      escalated_by     TEXT,
      escalated_at     TEXT,
      escalation_note  TEXT,
      edited_at        TEXT,
      edit_count       INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sub_created  ON submissions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sub_status   ON submissions(status);
    CREATE INDEX IF NOT EXISTS idx_sub_priority ON submissions(priority, priority_score DESC);
    CREATE INDEX IF NOT EXISTS idx_sub_dept     ON submissions(department);

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      author_type   TEXT NOT NULL CHECK (author_type IN ('admin','reporter')),
      message_text  TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_sub ON messages(submission_id, created_at);

    CREATE TABLE IF NOT EXISTS users (
      email             TEXT PRIMARY KEY,
      full_name         TEXT,
      reason            TEXT,
      role              TEXT NOT NULL DEFAULT 'staff',
      departments       TEXT NOT NULL DEFAULT '[]',
      status            TEXT NOT NULL,
      source            TEXT,
      password_hash     TEXT,
      password_set_at   TEXT,
      email_verified_at TEXT,
      approved_by       TEXT,
      approved_at       TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS appreciations (
      id               TEXT PRIMARY KEY,
      recipient_name   TEXT NOT NULL,
      recipient_team   TEXT NOT NULL DEFAULT 'Unspecified',
      category         TEXT NOT NULL,
      message_text     TEXT NOT NULL,
      from_team        TEXT NOT NULL DEFAULT 'Unspecified',
      -- Set at submission time if the nominator chose to be credited, null if
      -- they preferred not to be. There is no later reveal: praising someone
      -- carries no retaliation risk, so the decision is made once, on the form.
      nominator_name   TEXT,
      status           TEXT NOT NULL DEFAULT 'new',
      acknowledged_by  TEXT,
      acknowledged_at  TEXT,
      spotlight        INTEGER NOT NULL DEFAULT 0,
      spotlight_by     TEXT,
      spotlight_at     TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appr_created ON appreciations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_appr_team    ON appreciations(recipient_team);

    CREATE TABLE IF NOT EXISTS notifications (
      id            TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      title         TEXT NOT NULL,
      body          TEXT,
      read_at       TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_sub ON notifications(submission_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket   TEXT PRIMARY KEY,
      count    INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
  `);
}

function get() {
  return db || open();
}

function close() {
  if (db) { db.close(); db = null; }
}

// Rows are snake_case; the rest of the app speaks camelCase.
function toCamel(row) {
  if (!row) { return null; }
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, character) => character.toUpperCase())] = value;
  }
  return out;
}

function json(value, fallback) {
  if (value === null || value === undefined) { return fallback; }
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function tables() {
  return get().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);
}

module.exports = { open, get, close, toCamel, json, tables };
