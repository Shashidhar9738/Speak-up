const crypto = require("crypto");
const db = require("./db");

/**
 * Appreciation — the positive counterpart to a complaint.
 *
 * Kept in its own store rather than as a flag on submissions, for two reasons:
 *
 *   1. A complaint is anonymous BY DESIGN and must stay that way. Appreciation
 *      is the opposite: it names someone, and the point is that they hear about
 *      it. Mixing them in one table makes it far too easy for a query written
 *      for one purpose to leak the other.
 *   2. The nominator may choose to reveal themselves later so the thanks can be
 *      attributed. Complaints have no such path and never should.
 *
 * The nominator is still anonymous by default. Only the *recipient* is named.
 */

const CATEGORIES = [
  { id: "mentorship", label: "Mentorship", icon: "ti-school", colour: "#4a3aa7" },
  { id: "teamwork", label: "Teamwork", icon: "ti-users", colour: "#2a78d6" },
  { id: "going-above", label: "Went above and beyond", icon: "ti-rocket", colour: "#eb6834" },
  { id: "leadership", label: "Leadership", icon: "ti-compass", colour: "#1baf7a" },
  { id: "craft", label: "Quality of work", icon: "ti-award", colour: "#eda100" },
  { id: "kindness", label: "Everyday kindness", icon: "ti-heart", colour: "#e87ba4" }
];

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

function rowToAppreciation(row) {
  if (!row) { return null; }
  const value = db.toCamel(row);
  return {
    id: value.id,
    recipientName: value.recipientName,
    recipientTeam: value.recipientTeam,
    category: value.category,
    messageText: value.messageText,
    fromTeam: value.fromTeam,
    nominatorName: value.nominatorName || null,
    status: value.status,
    acknowledgedBy: value.acknowledgedBy || null,
    acknowledgedAt: value.acknowledgedAt || null,
    spotlight: Boolean(value.spotlight),
    spotlightBy: value.spotlightBy || null,
    spotlightAt: value.spotlightAt || null,
    accessCodeHash: value.accessCodeHash,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function upsert(record) {
  db.get().prepare(`
    INSERT INTO appreciations (
      id, recipient_name, recipient_team, category, message_text, from_team,
      nominator_name, status,
      acknowledged_by, acknowledged_at, spotlight, spotlight_by, spotlight_at,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      recipient_name = excluded.recipient_name,
      recipient_team = excluded.recipient_team,
      category = excluded.category,
      message_text = excluded.message_text,
      from_team = excluded.from_team,
      nominator_name = excluded.nominator_name,
      status = excluded.status,
      acknowledged_by = excluded.acknowledged_by,
      acknowledged_at = excluded.acknowledged_at,
      spotlight = excluded.spotlight,
      spotlight_by = excluded.spotlight_by,
      spotlight_at = excluded.spotlight_at,
      updated_at = excluded.updated_at
  `).run(
    record.id, record.recipientName, record.recipientTeam, record.category,
    record.messageText, record.fromTeam,
    record.nominatorName || null,
    record.status, record.acknowledgedBy || null, record.acknowledgedAt || null,
    record.spotlight ? 1 : 0, record.spotlightBy || null, record.spotlightAt || null,
    record.createdAt, record.updatedAt
  );
  return record;
}

function createId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.randomBytes(8);
  let body = "";
  for (let i = 0; i < 8; i += 1) { body += alphabet[bytes[i] % alphabet.length]; }
  return `KUD-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * Suggested replies for an admin acknowledging a kudos. Templates, not a model:
 * the tone options come from the category and the recipient's name, which is
 * all the context a two-line thank-you needs.
 */
function suggestReplies(appreciation) {
  const who = appreciation.recipientName || "they";
  const category = CATEGORIES.find((c) => c.id === appreciation.category);
  const topic = category ? category.label.toLowerCase() : "this";

  return [
    {
      tone: "Warm",
      text: `Thank you for taking the time to call this out. ${who} clearly made a real difference here, and it is good to see ${topic} noticed by the people around them.`
    },
    {
      tone: "Brief",
      text: `Noted and appreciated — passing this on to ${who}. Thank you for flagging it.`
    },
    {
      tone: "Formal",
      text: `Thank you for the nomination. Recognition of ${topic} matters to how we work, and this has been recorded and shared with ${who}'s manager.`
    }
  ];
}

async function createAppreciation(input) {
  const now = new Date().toISOString();

  const record = {
    id: createId(),
    recipientName: String(input.recipientName || "").trim().slice(0, 120),
    recipientTeam: String(input.recipientTeam || "").trim().slice(0, 80) || "Unspecified",
    category: CATEGORY_IDS.has(input.category) ? input.category : "teamwork",
    messageText: String(input.messageText || "").trim(),
    fromTeam: String(input.fromTeam || "").trim().slice(0, 80) || "Unspecified",
    // Optional, decided on the form. Blank means the nominator preferred not to
    // be named — there is no mechanism to attach it afterwards, and none is
    // needed: unlike a complaint, praising a colleague risks nothing.
    nominatorName: String(input.nominatorName || "").trim().slice(0, 120) || null,
    status: "new",
    acknowledgedBy: null,
    acknowledgedAt: null,
    spotlight: false,
    createdAt: now,
    updatedAt: now
  };

  upsert(record);
  return { appreciation: record };
}

async function listAppreciations(query) {
  const q = query || {};
  const where = [];
  const params = [];

  if (q.category) { where.push("category = ?"); params.push(q.category); }
  if (q.status) { where.push("status = ?"); params.push(q.status); }
  if (q.team) { where.push("recipient_team = ?"); params.push(q.team); }
  if (q.spotlight === "true") { where.push("spotlight = 1"); }

  const sql = "SELECT * FROM appreciations" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY created_at DESC";

  return db.get().prepare(sql).all(...params).map(rowToAppreciation);
}

async function getById(id) {
  const row = db.get().prepare("SELECT * FROM appreciations WHERE id = ?").get(String(id || "").trim());
  return rowToAppreciation(row);
}

async function updateAppreciation(id, updater) {
  const existing = await getById(id);
  if (!existing) { return null; }
  return upsert(updater(existing));
}

function publicAppreciation(appreciation) {
  return appreciation;
}

/**
 * Metrics. The interesting number is not the total but the *distribution*:
 * a team that never appears is the signal worth acting on.
 */
function buildAppreciationMetrics(list, knownTeams) {
  const byCategory = {};
  const byRecipientTeam = {};
  const byNominatingTeam = {};
  const recipients = {};
  const weekly = {};

  list.forEach((a) => {
    byCategory[a.category] = (byCategory[a.category] || 0) + 1;
    byRecipientTeam[a.recipientTeam] = (byRecipientTeam[a.recipientTeam] || 0) + 1;
    byNominatingTeam[a.fromTeam] = (byNominatingTeam[a.fromTeam] || 0) + 1;
    if (a.recipientName) {
      recipients[a.recipientName] = (recipients[a.recipientName] || 0) + 1;
    }
    const week = a.createdAt.slice(0, 10);
    weekly[week] = (weekly[week] || 0) + 1;
  });

  // Teams present in the org but absent from the praise data.
  const overlooked = (knownTeams || [])
    .filter((team) => team !== "Unspecified" && !byRecipientTeam[team])
    .sort();

  return {
    total: list.length,
    newCount: list.filter((a) => a.status === "new").length,
    spotlights: list.filter((a) => a.spotlight).length,
    attributed: list.filter((a) => a.nominatorName).length,
    byCategory,
    byRecipientTeam,
    byNominatingTeam,
    topRecipients: Object.entries(recipients)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    overlookedTeams: overlooked,
    daily: Object.entries(weekly).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, count]) => ({ day, count }))
  };
}


/**
 * Bright Spots digest — a weekly leadership summary of appreciation.
 *
 * Returned as HTML so it can be pasted into an email or opened in a browser.
 * The PNG "shareable card" from the original spec is deliberately not built:
 * it needs headless rendering, and the digest carries almost all of the value
 * at a fraction of the cost.
 *
 * Recipients are named — that is the point of recognition. Nominators are NOT,
 * unless they explicitly attributed themselves.
 */
function buildDigest(list, options) {
  const settings = options || {};
  const days = Number(settings.days || 7);
  const since = Date.now() - days * 86400000;
  const recent = list.filter((a) => new Date(a.createdAt).getTime() >= since);

  const byRecipient = {};
  const byCategory = {};
  recent.forEach((a) => {
    byRecipient[a.recipientName] = (byRecipient[a.recipientName] || 0) + 1;
    byCategory[a.category] = (byCategory[a.category] || 0) + 1;
  });

  const spotlights = recent.filter((a) => a.spotlight);
  const rest = recent.filter((a) => !a.spotlight);
  const byDetail = (a, b) => (b.messageText || "").length - (a.messageText || "").length;

  // Spotlights lead, then the longest notes — detail is what makes recognition
  // feel earned. Filling from the rest matters: showing only the one
  // spotlighted item would hide everything else that came in that week.
  const highlights = spotlights.slice().sort(byDetail)
    .concat(rest.slice().sort(byDetail))
    .slice(0, 5);

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),
    total: recent.length,
    uniqueRecipients: Object.keys(byRecipient).length,
    spotlights: spotlights.length,
    byCategory,
    topRecipients: Object.entries(byRecipient)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    highlights: highlights.map((a) => ({
      id: a.id,
      recipientName: a.recipientName,
      recipientTeam: a.recipientTeam,
      category: a.category,
      messageText: a.messageText,
      from: a.nominatorName || "a colleague",
      spotlight: a.spotlight
    }))
  };
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function digestToHtml(digest) {
  const label = (id) => {
    const found = CATEGORIES.find((c) => c.id === id);
    return found ? found.label : id;
  };
  const colour = (id) => {
    const found = CATEGORIES.find((c) => c.id === id);
    return found ? found.colour : "#64748b";
  };

  const cards = digest.highlights.map((h) => `
    <tr><td style="padding:0 0 12px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ebf0;border-left:3px solid ${colour(h.category)};border-radius:10px;">
        <tr><td style="padding:15px 17px;">
          <div style="font:600 15px Inter,Arial,sans-serif;color:#0f1420;">
            ${escapeHtml(h.recipientName)}
            <span style="font:500 11px Inter,Arial,sans-serif;color:${colour(h.category)};background:${colour(h.category)}1a;padding:3px 9px;border-radius:20px;margin-left:6px;">${escapeHtml(label(h.category))}</span>
            ${h.spotlight ? '<span style="font:600 11px Inter,Arial,sans-serif;color:#92400e;background:#fef3c7;padding:3px 9px;border-radius:20px;margin-left:4px;">Spotlight</span>' : ""}
          </div>
          <div style="font:400 13.5px/1.6 Inter,Arial,sans-serif;color:#5b6474;margin-top:9px;">${escapeHtml(h.messageText)}</div>
          <div style="font:400 11.5px Inter,Arial,sans-serif;color:#98a1b0;margin-top:10px;">${escapeHtml(h.recipientTeam)} &middot; from ${escapeHtml(h.from)}</div>
        </td></tr>
      </table>
    </td></tr>`).join("");

  const recipients = digest.topRecipients.map((r) =>
    `<span style="display:inline-block;font:500 12px Inter,Arial,sans-serif;background:#eef1fe;color:#4f46e5;padding:4px 11px;border-radius:20px;margin:0 5px 5px 0;">${escapeHtml(r.name)} &times;${r.count}</span>`
  ).join("");

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
    <tr><td style="background:linear-gradient(135deg,#14162a,#1b1e35);border-radius:16px;padding:26px 28px;">
      <div style="font:700 11px Inter,Arial,sans-serif;color:#7d87a6;letter-spacing:1.3px;text-transform:uppercase;">Bright spots &middot; last ${digest.periodDays} days</div>
      <div style="font:700 25px Inter,Arial,sans-serif;color:#fff;letter-spacing:-.7px;margin-top:8px;">
        ${digest.total} ${digest.total === 1 ? "person was" : "people were"} thanked by a colleague
      </div>
      <div style="font:400 13.5px Inter,Arial,sans-serif;color:#b9c0d4;margin-top:7px;">
        ${digest.uniqueRecipients} named individually${digest.spotlights ? ` &middot; ${digest.spotlights} spotlighted` : ""}
      </div>
    </td></tr>
    <tr><td style="height:20px;"></td></tr>
    ${digest.topRecipients.length ? `<tr><td style="padding-bottom:16px;">
      <div style="font:600 12px Inter,Arial,sans-serif;color:#5b6474;margin-bottom:8px;">Recognised most</div>
      ${recipients}
    </td></tr>` : ""}
    ${cards || `<tr><td style="font:400 13px Inter,Arial,sans-serif;color:#98a1b0;padding:20px;text-align:center;">
      No appreciation in this period.</td></tr>`}
    <tr><td style="font:400 11.5px Inter,Arial,sans-serif;color:#98a1b0;padding-top:14px;text-align:center;">
      Nominators are named only where they chose to be.
    </td></tr>
  </table></body></html>`;
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  createAppreciation,
  listAppreciations,
  getById,
  updateAppreciation,
  publicAppreciation,
  buildAppreciationMetrics,
  suggestReplies,
  buildDigest,
  digestToHtml
};
