/**
 * Back up the database.
 *
 *   node backend/scripts/backup.js            -> backend/backups/speakup-<stamp>.db
 *   node backend/scripts/backup.js <dir>      -> somewhere else, e.g. a synced folder
 *
 * Pushing to GitHub does NOT back this up: backend/data is gitignored on
 * purpose, because it holds real complaints and employee email addresses. This
 * is the only backup there is.
 *
 * Uses SQLite's own VACUUM INTO rather than copying the file. A plain copy of a
 * live database can catch it mid-write and produce a backup that will not open;
 * VACUUM INTO takes a consistent snapshot and compacts it.
 */
const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const db = require("../src/services/db");
const audit = require("../src/services/auditService");

const KEEP = Number(process.env.SPEAKUP_BACKUP_KEEP || 10);

function main() {
  if (!fs.existsSync(config.databaseFile)) {
    console.error(`  no database at ${config.databaseFile} — nothing to back up`);
    process.exit(1);
  }

  const target = process.argv[2] || path.join(__dirname, "..", "backups");
  fs.mkdirSync(target, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(target, `speakup-${stamp}.db`);

  db.open();
  // Backslashes are legal in Windows paths but not inside a SQL string literal.
  db.get().exec(`VACUUM INTO '${file.replace(/\\/g, "/").replace(/'/g, "''")}'`);

  const rows = db.get().prepare("SELECT COUNT(*) AS n FROM submissions").get().n;
  const size = (fs.statSync(file).size / 1024).toFixed(0);
  db.close();

  console.log();
  console.log(`  backed up ${rows} submissions -> ${path.relative(process.cwd(), file)} (${size} KB)`);

  // Keep the most recent few; an unbounded backup directory quietly fills a disk.
  const existing = fs.readdirSync(target)
    .filter((name) => /^speakup-.*\.db$/.test(name))
    .sort()
    .reverse();

  const stale = existing.slice(KEEP);
  stale.forEach((name) => fs.rmSync(path.join(target, name), { force: true }));

  console.log(`  keeping ${Math.min(existing.length, KEEP)} backup(s)` +
    (stale.length ? `, removed ${stale.length} older` : ""));

  audit.record("database.backup", "cli", { file: path.basename(file), submissions: rows });

  console.log();
  console.log("  Restore by stopping the app and copying the file over");
  console.log(`  ${path.relative(process.cwd(), config.databaseFile)}`);
  console.log();
}

try {
  main();
} catch (error) {
  console.error("  backup failed:", error.message);
  process.exit(1);
}
