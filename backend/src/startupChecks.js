/**
 * Boot-time review of the access configuration.
 *
 * Who can reach the dashboard is decided entirely by environment variables, and
 * the dangerous combinations are dangerous *silently*: the app starts, the
 * health check passes, and nothing anywhere says that every complaint is now
 * readable by anyone who fills in the registration form.
 *
 * The specific trap this exists for: SPEAKUP_ADMIN_DOMAINS is set to a public
 * mail provider (the live deployment uses gmail.com, because the owner's own
 * address is a gmail one), while SPEAKUP_AUTO_APPROVE defaults to true. Those
 * two settings are individually reasonable and jointly mean that any address on
 * that provider — anywhere in the world — self-approves into an account that
 * reads complaint text company-wide. Only the second variable being set to
 * "false" prevents it, and nothing noticed if it was not.
 *
 * These checks report; they do not block. A misconfigured instance is still a
 * running instance, and refusing to boot would turn a privacy problem into an
 * outage on the next deploy. Set SPEAKUP_STRICT_ACCESS=true to make a critical
 * finding fatal instead, once the configuration is known to be right.
 */
const { DEFAULT_ADMIN_EMAILS } = require("./config");

// Providers where an address proves nothing about who holds it: anyone can have
// one in seconds, so "verified domain" stops being an access control at all.
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "ymail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
  "yandex.com", "zoho.com", "tutanota.com", "fastmail.com",
  "qq.com", "163.com", "126.com", "rediffmail.com"
]);

// Roles that read the sensitive categories. Self-registration must never land
// on one of these: harassment and security reports are exactly the reports most
// likely to name the person reading them.
const PRIVILEGED_ROLES = new Set(["owner", "reviewer"]);

function publicProviders(domains) {
  return (domains || [])
    .map((domain) => String(domain).trim().toLowerCase())
    .filter((domain) => PUBLIC_MAIL_DOMAINS.has(domain));
}

function isPlaceholderOwners(emails) {
  const configured = (emails || []).map((email) => String(email).toLowerCase()).sort();
  const placeholder = DEFAULT_ADMIN_EMAILS.map((email) => email.toLowerCase()).sort();
  return configured.length === placeholder.length
    && configured.every((email, index) => email === placeholder[index]);
}

/**
 * Findings for a settings object, worst first. Takes the settings rather than
 * reading config directly so the combinations can be tested without setting
 * environment variables for the whole process.
 */
function accessRisks(settings) {
  const risks = [];
  const domains = settings.adminDomains || [];
  const open = publicProviders(domains);
  const role = settings.defaultRole || "staff";

  if (settings.autoApprove && open.length) {
    risks.push({
      code: "open_registration",
      severity: "critical",
      summary: `Anyone with an @${open.join(" or @")} address can register and is approved automatically.`,
      detail: `Approved accounts get the "${role}" role, which reads complaint text across every department. `
        + "Set SPEAKUP_AUTO_APPROVE=false to hold registrations in an owner approval queue."
    });
  }

  if (PRIVILEGED_ROLES.has(role)) {
    risks.push({
      code: "privileged_default_role",
      severity: "critical",
      summary: `SPEAKUP_DEFAULT_ROLE is "${role}", so every self-registration is granted that role.`,
      detail: "owner and reviewer both read the sensitive categories, and owner can approve further accounts. "
        + "Registration should grant \"staff\" or \"analyst\"."
    });
  }

  if (settings.isProduction && isPlaceholderOwners(settings.adminEmails)) {
    risks.push({
      code: "placeholder_owners",
      severity: "critical",
      summary: "SPEAKUP_ADMIN_EMAILS is unset, so the bootstrap owners are the placeholder addresses in config.js.",
      detail: "No real person holds the owner role. If registrations are queued, nobody can empty the queue."
    });
  }

  if (settings.autoApprove && !settings.requireVerification && domains.length) {
    risks.push({
      code: "unverified_auto_approval",
      severity: "warning",
      summary: "Accounts are approved without the emailed code ever being checked.",
      detail: "Nothing proves the registrant owns the address they typed, so an account can be taken out in a "
        + "colleague's name. Set SPEAKUP_REQUIRE_VERIFICATION=true (requires SPEAKUP_SMTP_URL)."
    });
  }

  return risks;
}

function isCritical(risk) {
  return risk.severity === "critical";
}

/**
 * Print the findings. Kept separate from accessRisks so the decision and the
 * reporting can be tested apart from each other.
 */
function reportAccessRisks(settings, log) {
  const risks = accessRisks(settings);
  const write = log || console.warn;

  if (!risks.length) {
    return risks;
  }

  write("");
  write("  ACCESS CONFIGURATION");
  risks.forEach((risk) => {
    write(`  ${isCritical(risk) ? "CRITICAL" : "warning"}: ${risk.summary}`);
    write(`    ${risk.detail}`);
  });

  if (settings.strictAccess && risks.some(isCritical)) {
    throw new Error(
      "SPEAKUP_STRICT_ACCESS is on and the access configuration has a critical finding: "
      + risks.filter(isCritical).map((risk) => risk.code).join(", ")
    );
  }

  return risks;
}

module.exports = {
  PUBLIC_MAIL_DOMAINS,
  accessRisks,
  reportAccessRisks
};
