/**
 * Who may see which complaints.
 *
 * The dashboard holds anonymous reports, and the subject of a report is often
 * the reader's own manager or department head. Access is therefore segregated
 * on two independent axes, and BOTH are enforced server-side — never by hiding
 * things in the browser, which any reader could trivially undo.
 *
 *   1. Sensitivity — harassment, ethics and security reports are the ones most
 *      likely to name a senior person, so they are restricted to the smallest
 *      circle regardless of department.
 *   2. Department  — a department lead sees their own area, not the whole company.
 *
 * Roles:
 *   owner      CXO / SpeakUp administrator. Everything, plus account management.
 *   reviewer   HR or Compliance. Everything except account management.
 *   lead       Department lead. Own departments only, sensitive categories hidden.
 *   staff      Any verified employee. Reads complaints company-wide, but not the
 *              sensitive categories, and cannot act on them.
 *   analyst    Aggregate numbers only — no raw complaint text at all.
 */

const ROLES = {
  OWNER: "owner",
  REVIEWER: "reviewer",
  LEAD: "lead",
  STAFF: "staff",
  ANALYST: "analyst"
};

const ROLE_LABELS = {
  owner: "Owner (CXO)",
  reviewer: "Reviewer (HR / Compliance)",
  lead: "Department lead",
  staff: "Staff (read-only)",
  analyst: "Analyst (aggregates only)"
};

// Categories that can expose the reporter or name a senior individual.
const SENSITIVE_CATEGORIES = new Set(["Harassment & Ethics", "Security & Compliance"]);

const CAPABILITIES = {
  owner: { sensitive: true, allDepartments: true, rawText: true, manageUsers: true, export: true, respond: true },
  reviewer: { sensitive: true, allDepartments: true, rawText: true, manageUsers: false, export: true, respond: true },
  lead: { sensitive: false, allDepartments: false, rawText: true, manageUsers: false, export: false, respond: true },
  staff: { sensitive: false, allDepartments: true, rawText: true, manageUsers: false, export: false, respond: false },
  analyst: { sensitive: false, allDepartments: true, rawText: false, manageUsers: false, export: false, respond: false }
};

function capabilitiesFor(role) {
  return CAPABILITIES[role] || CAPABILITIES.analyst;
}

function isSensitive(submission) {
  return SENSITIVE_CATEGORIES.has(submission.category) || submission.flags?.sensitive === true;
}

/**
 * True when this user is allowed to see this specific submission at all.
 */
function canSeeSubmission(user, submission) {
  const capabilities = capabilitiesFor(user.role);

  if (isSensitive(submission) && !capabilities.sensitive) {
    return false;
  }

  if (!capabilities.allDepartments) {
    const scope = Array.isArray(user.departments) ? user.departments : [];
    if (!scope.includes(submission.department)) {
      return false;
    }
  }

  return true;
}

function visibleSubmissions(user, submissions) {
  return submissions.filter((submission) => canSeeSubmission(user, submission));
}

/**
 * Strip fields this role must not read. Analysts get counts and categories but
 * never the complaint itself, because free text is the main re-identification
 * risk ("the only person on maternity leave in Finance").
 */
function redact(user, submission) {
  const capabilities = capabilitiesFor(user.role);
  const { accessCodeHash, ...safe } = submission;

  if (capabilities.rawText) {
    return safe;
  }

  return {
    id: safe.id,
    category: safe.category,
    sentiment: safe.sentiment,
    priority: safe.priority,
    priorityScore: safe.priorityScore,
    status: safe.status,
    department: safe.department,
    region: safe.region,
    channel: safe.channel,
    createdAt: safe.createdAt,
    updatedAt: safe.updatedAt,
    keywords: safe.keywords,
    redacted: true
  };
}

function describeScope(user) {
  const capabilities = capabilitiesFor(user.role);
  return {
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    departments: capabilities.allDepartments ? "all" : (user.departments || []),
    seesSensitive: capabilities.sensitive,
    seesRawText: capabilities.rawText,
    canManageUsers: capabilities.manageUsers,
    canExport: capabilities.export,
    canRespond: capabilities.respond
  };
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  SENSITIVE_CATEGORIES,
  capabilitiesFor,
  isSensitive,
  canSeeSubmission,
  visibleSubmissions,
  redact,
  describeScope
};
