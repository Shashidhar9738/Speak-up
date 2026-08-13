/**
 * One-off migration: the JSON stores into SQLite.
 *
 * Safe to run more than once — every insert is an upsert keyed on the record's
 * own id, so a re-run updates rather than duplicates. The JSON files are left
 * untouched so there is always something to fall back to.
 *
 *   node backend/scripts/migrate-json-to-sqlite.js
 */
const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const db = require("../src/services/db");

function readJson(file, key) {
  if (!fs.existsSync(file)) { return []; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    return Array.isArray(parsed[key]) ? parsed[key] : [];
  } catch (error) {
    console.warn(`  ! could not read ${path.basename(file)}: ${error.message}`);
    return [];
  }
}

function migrate() {
  db.open();
  const database = db.get();

  const submissions = readJson(config.dataFilePath, "submissions");
  const users = readJson(config.userFilePath, "users");
  const appreciations = readJson(config.appreciationFilePath, "appreciations");

  let migratedSubmissions = 0;
  let migratedMessages = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    const insertSubmission = database.prepare(`
      INSERT INTO submissions (
        id, message_text, summary, category, keywords, sentiment,
        priority, priority_score, priority_label, priority_colour,
        priority_reason, priority_terms, sla, status, status_note,
        department, region, channel, quarantined,
        flag_spam, flag_urgent, flag_sensitive, browser_locale,
        access_code_hash, edited_at, edit_count, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        message_text = excluded.message_text, summary = excluded.summary,
        category = excluded.category, keywords = excluded.keywords,
        sentiment = excluded.sentiment, priority = excluded.priority,
        priority_score = excluded.priority_score, priority_label = excluded.priority_label,
        priority_colour = excluded.priority_colour, priority_reason = excluded.priority_reason,
        priority_terms = excluded.priority_terms, sla = excluded.sla,
        status = excluded.status, status_note = excluded.status_note,
        updated_at = excluded.updated_at
    `);

    const insertMessage = database.prepare(
      "INSERT OR REPLACE INTO messages (id, submission_id, author_type, message_text, created_at) VALUES (?,?,?,?,?)"
    );

    for (const s of submissions) {
      // A record with no access code hash cannot be tracked by its reporter and
      // is almost certainly test data; skip rather than invent a credential.
      if (!s.accessCodeHash) {
        console.warn(`  ! skipping ${s.id}: no access code hash`);
        continue;
      }

      insertSubmission.run(
        s.id, s.messageText, s.summary, s.category,
        JSON.stringify(s.keywords || []), s.sentiment,
        s.priority, s.priorityScore || 0, s.priorityLabel || null, s.priorityColour || null,
        s.priorityReason || null, JSON.stringify(s.priorityTerms || []), s.sla || null,
        s.status || "open", s.statusNote || null,
        s.department || "Unspecified", s.region || "Unspecified", s.channel || "web",
        s.quarantined ? 1 : 0,
        s.flags?.spam ? 1 : 0, s.flags?.urgent ? 1 : 0, s.flags?.sensitive ? 1 : 0,
        s.metadata?.browserLocale || "unknown",
        s.accessCodeHash, s.editedAt || null, s.editCount || 0,
        s.createdAt, s.updatedAt
      );
      migratedSubmissions += 1;

      for (const m of s.messages || []) {
        insertMessage.run(m.id, s.id, m.authorType, m.messageText, m.createdAt);
        migratedMessages += 1;
      }
    }

    const insertUser = database.prepare(`
      INSERT INTO users (
        email, full_name, reason, role, departments, status, source,
        password_hash, password_set_at, email_verified_at,
        approved_by, approved_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET
        role = excluded.role, departments = excluded.departments,
        status = excluded.status, password_hash = excluded.password_hash,
        updated_at = excluded.updated_at
    `);

    for (const u of users) {
      insertUser.run(
        u.email, u.fullName || null, u.reason || null, u.role || "staff",
        JSON.stringify(u.departments || []), u.status, u.source || null,
        u.passwordHash || null, u.passwordSetAt || null, u.emailVerifiedAt || null,
        u.approvedBy || null, u.approvedAt || null,
        u.createdAt, u.updatedAt
      );
    }

    const insertAppreciation = database.prepare(`
      INSERT INTO appreciations (
        id, recipient_name, recipient_team, category, message_text, from_team,
        nominator_name, revealed, revealed_at, status,
        acknowledged_by, acknowledged_at, spotlight, spotlight_by, spotlight_at,
        access_code_hash, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, spotlight = excluded.spotlight,
        nominator_name = excluded.nominator_name, revealed = excluded.revealed,
        updated_at = excluded.updated_at
    `);

    for (const a of appreciations) {
      insertAppreciation.run(
        a.id, a.recipientName, a.recipientTeam || "Unspecified", a.category,
        a.messageText, a.fromTeam || "Unspecified",
        a.nominatorName || null, a.revealed ? 1 : 0, a.revealedAt || null,
        a.status || "new", a.acknowledgedBy || null, a.acknowledgedAt || null,
        a.spotlight ? 1 : 0, a.spotlightBy || null, a.spotlightAt || null,
        a.accessCodeHash, a.createdAt, a.updatedAt
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const count = (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  console.log("  migrated into " + path.basename(config.databaseFile));
  console.log(`    submissions   ${migratedSubmissions} (${count("submissions")} in table)`);
  console.log(`    messages      ${migratedMessages} (${count("messages")} in table)`);
  console.log(`    users         ${users.length} (${count("users")} in table)`);
  console.log(`    appreciations ${appreciations.length} (${count("appreciations")} in table)`);
  console.log("  JSON files left in place as a fallback.");

  db.close();
}

migrate();
