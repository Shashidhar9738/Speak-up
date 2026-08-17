/**
 * Snapshot the whole working state — a restore point before a risky change.
 *
 *   npm run snapshot            -> snapshots/2026-08-17T09-12-04/
 *   npm run snapshot "before-redesign"
 *
 * This replaces an earlier restore_frontend.sh, which copied the HTML pages
 * into a folder. Those pages are already committed, so git restores them
 * better than a copy does. What git deliberately does NOT hold is the part
 * that actually cannot be recreated:
 *
 *   backend/data/speakup.db   the complaints themselves
 *   backend/data/audit.log    who read what
 *   .env                      configuration
 *   CREDENTIALS.md            working passwords
 *
 * So this captures those, plus the pages, so one folder is a complete restore
 * point rather than a partial one.
 */
const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const db = require("../src/services/db");

const ROOT = path.join(__dirname, "..", "..");

// Committed and therefore recoverable from git, but included so a snapshot
// folder stands alone without needing the right commit checked out.
const PAGES = [
  "index.html", "login.html", "register.html",
  "submit.html", "track.html", "users.html", "appreciation.html"
];

// The part git does not have, and nothing else can recreate.
const IRREPLACEABLE = [
  [config.databaseFile, "speakup.db"],
  [config.auditFile, "audit.log"],
  [path.join(ROOT, ".env"), ".env"],
  [path.join(ROOT, "CREDENTIALS.md"), "CREDENTIALS.md"]
];

function main() {
  const label = process.argv[2];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.join(ROOT, "snapshots", label ? `${stamp}-${label}` : stamp);

  fs.mkdirSync(path.join(target, "pages"), { recursive: true });

  let copied = 0;
  let missing = 0;

  for (const page of PAGES) {
    const source = path.join(ROOT, page);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(target, "pages", page));
      copied += 1;
    } else {
      console.warn(`  ! ${page} not found`);
      missing += 1;
    }
  }

  for (const [source, name] of IRREPLACEABLE) {
    if (!fs.existsSync(source)) { continue; }

    if (name === "speakup.db") {
      // A plain copy of a live database can catch it mid-write and produce a
      // file that will not open. VACUUM INTO takes a consistent snapshot.
      db.open();
      db.get().exec(`VACUUM INTO '${path.join(target, name).replace(/\\/g, "/").replace(/'/g, "''")}'`);
      db.close();
    } else {
      fs.copyFileSync(source, path.join(target, name));
    }
    copied += 1;
  }

  const commit = (() => {
    try {
      return require("child_process")
        .execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: "pipe" })
        .toString().trim();
    } catch (error) {
      return "unknown";
    }
  })();

  fs.writeFileSync(path.join(target, "SNAPSHOT.txt"),
    [
      `Taken:  ${new Date().toISOString()}`,
      `Commit: ${commit}`,
      label ? `Label:  ${label}` : "",
      "",
      "Restore:",
      "  stop the app",
      "  copy speakup.db over backend/data/speakup.db",
      "  copy .env and CREDENTIALS.md back to the project root",
      "  pages/ are also in git at the commit above, which is usually the",
      "  better source since it carries the matching backend code",
      ""
    ].filter(Boolean).join("\n"));

  console.log();
  console.log(`  snapshot -> ${path.relative(process.cwd(), target).replace(/\\/g, "/")}`);
  console.log(`  ${copied} file(s) captured${missing ? `, ${missing} page(s) missing` : ""}`);
  console.log(`  at commit ${commit}`);
  console.log();
}

try {
  main();
} catch (error) {
  console.error("  snapshot failed:", error.message);
  process.exit(1);
}
