const crypto = require("crypto");
const db = require("./db");

/**
 * Action plans.
 *
 * The gap this closes: a pattern is detected, someone reads it, and nothing
 * records what was done about it. Six months later nobody can say whether the
 * Sales harassment cluster was addressed or simply stopped being looked at.
 *
 * A plan links a detected pattern to an owner, a target date, and — the part
 * that matters — a measured before/after. Case management is common; showing
 * whether the fix actually reduced complaints is not.
 */

const STATUS = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  DONE: "done",
  ABANDONED: "abandoned"
};

const OWNERS = ["hr", "legal", "compliance", "department_lead", "leadership"];

function createId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.randomBytes(6);
  let body = "";
  for (let i = 0; i < 6; i += 1) { body += alphabet[bytes[i] % alphabet.length]; }
  return `ACT-${body.slice(0, 3)}-${body.slice(3)}`;
}

function rowToPlan(row) {
  if (!row) { return null; }
  const value = db.toCamel(row);
  return {
    id: value.id,
    title: value.title,
    detail: value.detail || "",
    patternId: value.patternId || null,
    department: value.department || null,
    category: value.category || null,
    owner: value.owner,
    ownerNote: value.ownerNote || null,
    status: value.status,
    dueAt: value.dueAt || null,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt || null,
    // Complaint count for this department+category when the plan was opened.
    baselineCount: value.baselineCount,
    baselineFrom: value.baselineFrom
  };
}

function upsert(plan) {
  db.get().prepare(`
    INSERT INTO action_plans (
      id, title, detail, pattern_id, department, category, owner, owner_note,
      status, due_at, created_by, baseline_count, baseline_from,
      completed_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, detail = excluded.detail,
      owner = excluded.owner, owner_note = excluded.owner_note,
      status = excluded.status, due_at = excluded.due_at,
      completed_at = excluded.completed_at, updated_at = excluded.updated_at
  `).run(
    plan.id, plan.title, plan.detail || null, plan.patternId || null,
    plan.department || null, plan.category || null, plan.owner, plan.ownerNote || null,
    plan.status, plan.dueAt || null, plan.createdBy,
    plan.baselineCount, plan.baselineFrom,
    plan.completedAt || null, plan.createdAt, plan.updatedAt
  );
  return plan;
}

/**
 * The baseline is captured at creation and never recalculated. Measuring
 * against a moving number would let a plan look effective simply because the
 * comparison window shifted.
 */
function create(input, submissions) {
  const now = new Date().toISOString();
  const windowDays = 30;
  const since = Date.now() - windowDays * 86400000;

  const matching = (submissions || []).filter((s) =>
    (!input.department || s.department === input.department) &&
    (!input.category || s.category === input.category) &&
    new Date(s.createdAt).getTime() >= since);

  const plan = {
    id: createId(),
    title: String(input.title || "").trim().slice(0, 160),
    detail: String(input.detail || "").trim().slice(0, 2000),
    patternId: input.patternId || null,
    department: input.department || null,
    category: input.category || null,
    owner: OWNERS.includes(input.owner) ? input.owner : "leadership",
    ownerNote: String(input.ownerNote || "").trim().slice(0, 160) || null,
    status: STATUS.OPEN,
    dueAt: input.dueAt || null,
    createdBy: input.createdBy,
    baselineCount: matching.length,
    baselineFrom: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };

  upsert(plan);
  return plan;
}

function list() {
  return db.get()
    .prepare("SELECT * FROM action_plans ORDER BY created_at DESC")
    .all().map(rowToPlan);
}

function getById(id) {
  return rowToPlan(db.get()
    .prepare("SELECT * FROM action_plans WHERE id = ?")
    .get(String(id || "").trim()));
}

function update(id, changes) {
  const existing = getById(id);
  if (!existing) { return null; }

  const now = new Date().toISOString();
  const next = { ...existing, ...changes, updatedAt: now };

  if (changes.status === STATUS.DONE && existing.status !== STATUS.DONE) {
    next.completedAt = now;
  }
  if (changes.status && changes.status !== STATUS.DONE) {
    next.completedAt = null;
  }

  return upsert(next);
}

/**
 * Did it work? Compares complaints since the plan opened against the baseline
 * captured then, over the same length of time so the comparison is fair.
 */
function measure(plan, submissions) {
  const openedAt = new Date(plan.baselineFrom).getTime();
  const elapsedDays = Math.max(1, (Date.now() - openedAt) / 86400000);

  const since = (submissions || []).filter((s) =>
    (!plan.department || s.department === plan.department) &&
    (!plan.category || s.category === plan.category) &&
    new Date(s.createdAt).getTime() >= openedAt);

  // The baseline covered 30 days; scale it to however long the plan has run.
  const expected = plan.baselineCount * (Math.min(elapsedDays, 30) / 30);
  const actual = since.length;

  let verdict = "too_early";
  if (elapsedDays >= 14) {
    if (actual === 0 && expected >= 1) { verdict = "resolved"; }
    else if (actual < expected * 0.6) { verdict = "improving"; }
    else if (actual > expected * 1.4) { verdict = "worsening"; }
    else { verdict = "unchanged"; }
  }

  return {
    baselineCount: plan.baselineCount,
    sinceCount: actual,
    expectedByNow: Math.round(expected * 10) / 10,
    elapsedDays: Math.round(elapsedDays),
    verdict,
    // Stated so nobody reads a two-day-old plan as evidence of anything.
    note: elapsedDays < 14
      ? "Too early to judge — needs at least 14 days."
      : `${actual} report(s) since, against ~${Math.round(expected)} expected at this rate.`
  };
}

function summarise(plans, submissions) {
  const open = plans.filter((p) => p.status === STATUS.OPEN || p.status === STATUS.IN_PROGRESS);
  const overdue = open.filter((p) => p.dueAt && new Date(p.dueAt).getTime() < Date.now());
  const done = plans.filter((p) => p.status === STATUS.DONE);

  const working = done.filter((p) => {
    const m = measure(p, submissions);
    return m.verdict === "improving" || m.verdict === "resolved";
  }).length;

  return {
    total: plans.length,
    open: open.length,
    overdue: overdue.length,
    done: done.length,
    // Of completed plans we can actually judge, how many moved the number.
    working
  };
}

module.exports = { STATUS, OWNERS, create, list, getById, update, measure, summarise };
