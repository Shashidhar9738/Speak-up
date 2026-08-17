/**
 * Retention policy — permanently delete resolved cases past their retention
 * period.
 *
 *   node backend/scripts/purge.js            # dry run, shows what would go
 *   node backend/scripts/purge.js --apply    # actually deletes
 *
 * Why a whistleblowing tool should forget
 * ---------------------------------------
 * Data you no longer hold cannot be leaked, subpoenaed, or read by a future
 * administrator with different intentions. A reporter who was promised
 * anonymity is safest when the record eventually stops existing at all. GDPR
 * and the EU Whistleblower Directive both expect a stated retention period
 * rather than keeping everything forever.
 *
 * What is deliberately NOT deleted
 * --------------------------------
 *   - open, acknowledged or escalated cases, at any age
 *   - the audit log, which records that a purge happened
 *
 * Set SPEAKUP_RETENTION_DAYS=0 to disable.
 */
const config = require("../src/config");
const db = require("../src/services/db");
const audit = require("../src/services/auditService");

function main() {
  const days = Number(config.retentionDays || 0);
  const apply = process.argv.includes("--apply");

  if (!days) {
    console.log("  retention is disabled (SPEAKUP_RETENTION_DAYS is 0 or unset)");
    console.log("  nothing will ever be deleted automatically");
    return;
  }

  db.open();
  const database = db.get();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Only settled cases, and only ones settled long enough ago. updated_at is
  // when it was resolved, which is the point the clock should start from —
  // not when it was submitted.
  const doomed = database.prepare(`
    SELECT id, category, department, updated_at
    FROM submissions
    WHERE status = 'resolved'
      AND merged_into IS NULL
      AND updated_at < ?
    ORDER BY updated_at ASC
  `).all(cutoff);

  const merged = database.prepare(`
    SELECT COUNT(*) AS n FROM submissions
    WHERE merged_into IN (SELECT id FROM submissions WHERE status = 'resolved' AND updated_at < ?)
  `).get(cutoff).n;

  console.log();
  console.log(`  retention: ${days} days after a case is resolved`);
  console.log(`  cutoff   : anything resolved before ${cutoff.slice(0, 10)}`);
  console.log();

  if (!doomed.length) {
    console.log("  nothing is old enough to delete");
    db.close();
    return;
  }

  console.log(`  ${doomed.length} resolved case(s) past retention:`);
  doomed.slice(0, 10).forEach((row) => {
    console.log(`    ${row.id}  ${row.department} / ${row.category}  resolved ${row.updated_at.slice(0, 10)}`);
  });
  if (doomed.length > 10) { console.log(`    ...and ${doomed.length - 10} more`); }
  if (merged) { console.log(`  plus ${merged} linked duplicate(s)`); }

  if (!apply) {
    console.log();
    console.log("  DRY RUN — nothing deleted. Re-run with --apply to proceed.");
    db.close();
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const remove = database.prepare("DELETE FROM submissions WHERE id = ?");
    // Messages and notifications carry ON DELETE CASCADE, so they go with the
    // parent rather than being orphaned.
    doomed.forEach((row) => {
      database.prepare("DELETE FROM submissions WHERE merged_into = ?").run(row.id);
      remove.run(row.id);
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  // The audit log keeps the fact of deletion, never the content. Someone must
  // be able to see that a purge ran without being able to read what it removed.
  audit.record("data.purged", "cli", {
    policyDays: days,
    cases: doomed.length,
    linked: merged,
    oldest: doomed[0].updated_at,
    newest: doomed[doomed.length - 1].updated_at
  });

  console.log();
  console.log(`  deleted ${doomed.length} case(s) and ${merged} linked duplicate(s)`);
  console.log("  recorded in the audit log — the fact, not the content");
  console.log();

  db.close();
}

try {
  main();
} catch (error) {
  console.error("  purge failed:", error.message);
  process.exit(1);
}
