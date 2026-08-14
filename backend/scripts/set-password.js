/**
 * Reset a dashboard password from the command line.
 *
 *   node backend/scripts/set-password.js someone@comviva.com "new-password"
 *   node backend/scripts/set-password.js someone@comviva.com --generate
 *
 * Passwords are scrypt hashes, so a forgotten one cannot be read back — this
 * is the recovery path. It writes straight to the database and needs no
 * running server.
 */
const db = require("../src/services/db");
const users = require("../src/services/userService");
const { validatePassword, generatePassword } = require("../src/services/passwordService");
const audit = require("../src/services/auditService");

async function main() {
  const [email, rawPassword] = process.argv.slice(2);

  if (!email) {
    console.error("usage: node backend/scripts/set-password.js <email> <password|--generate>");
    process.exit(1);
  }

  db.open();

  const user = await users.findUser(email);
  if (!user) {
    console.error(`  no account for ${email}`);
    const all = await users.listUsers();
    if (all.length) {
      console.error("  known accounts: " + all.map((u) => u.email).join(", "));
    }
    process.exit(1);
  }

  const generated = !rawPassword || rawPassword === "--generate";
  const password = generated ? generatePassword() : rawPassword;

  const check = validatePassword(password, email);
  if (!check.ok) {
    console.error(`  rejected: ${check.reason}`);
    process.exit(1);
  }

  await users.setPassword(email, password);
  // Recorded like any other privileged action; the trail should not have a gap
  // where someone changed a password out of band.
  audit.record("account.password_reset", "cli", { target: email, generated });

  console.log();
  console.log(`  password updated for ${email}  (role: ${user.role})`);
  if (generated) {
    console.log(`  new password: ${password}`);
    console.log("  shown once — store it in CREDENTIALS.md, which is gitignored");
  }
  console.log();

  db.close();
}

main().catch((error) => {
  console.error("  failed:", error.message);
  process.exit(1);
});
