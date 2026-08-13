const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config");

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

let mutationChain = Promise.resolve();
function withLock(operation) {
  const result = mutationChain.then(operation, operation);
  mutationChain = result.then(() => undefined, () => undefined);
  return result;
}

function storePath() {
  return config.appreciationFilePath;
}

async function ensureStore() {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  try {
    await fs.access(storePath());
  } catch {
    await fs.writeFile(storePath(), JSON.stringify({ appreciations: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const content = await fs.readFile(storePath(), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(content || "{}");
  } catch (error) {
    throw new Error(`Appreciation store at ${storePath()} is not valid JSON`);
  }
  return { appreciations: Array.isArray(parsed.appreciations) ? parsed.appreciations : [] };
}

async function writeStore(store) {
  await ensureStore();
  const payload = JSON.stringify({ appreciations: store.appreciations || [] }, null, 2);
  const temp = `${storePath()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, payload, "utf8");
    await fs.rename(temp, storePath());
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function createId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.randomBytes(8);
  let body = "";
  for (let i = 0; i < 8; i += 1) { body += alphabet[bytes[i] % alphabet.length]; }
  return `KUD-${body.slice(0, 4)}-${body.slice(4)}`;
}

function createAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let body = "";
  for (let i = 0; i < 10; i += 1) { body += alphabet[bytes[i] % alphabet.length]; }
  return `KDS-${body.slice(0, 5)}-${body.slice(5)}`;
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");
}

function codeMatches(candidate, storedHash) {
  if (!storedHash) { return false; }
  const left = Buffer.from(hashCode(candidate), "hex");
  const right = Buffer.from(storedHash, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
  const accessCode = createAccessCode();
  const now = new Date().toISOString();

  const record = {
    id: createId(),
    recipientName: String(input.recipientName || "").trim().slice(0, 120),
    recipientTeam: String(input.recipientTeam || "").trim().slice(0, 80) || "Unspecified",
    category: CATEGORY_IDS.has(input.category) ? input.category : "teamwork",
    messageText: String(input.messageText || "").trim(),
    fromTeam: String(input.fromTeam || "").trim().slice(0, 80) || "Unspecified",

    // Anonymous by default. The nominator may attach their name later through
    // the reveal flow, but never automatically.
    nominatorName: null,
    revealed: false,
    revealedAt: null,

    status: "new",
    acknowledgedBy: null,
    acknowledgedAt: null,
    spotlight: false,
    createdAt: now,
    updatedAt: now,
    accessCodeHash: hashCode(accessCode)
  };

  return withLock(async () => {
    const store = await readStore();
    store.appreciations.unshift(record);
    await writeStore(store);
    return { appreciation: record, accessCode };
  });
}

async function listAppreciations(query) {
  const q = query || {};
  const store = await readStore();
  return store.appreciations.filter((a) => {
    if (q.category && a.category !== q.category) { return false; }
    if (q.status && a.status !== q.status) { return false; }
    if (q.team && a.recipientTeam !== q.team) { return false; }
    if (q.spotlight === "true" && !a.spotlight) { return false; }
    return true;
  });
}

async function getById(id) {
  const store = await readStore();
  return store.appreciations.find((a) => a.id === String(id).trim()) || null;
}

async function updateAppreciation(id, updater) {
  return withLock(async () => {
    const store = await readStore();
    const index = store.appreciations.findIndex((a) => a.id === id);
    if (index === -1) { return null; }
    const next = updater(store.appreciations[index]);
    store.appreciations[index] = next;
    await writeStore(store);
    return next;
  });
}

/**
 * Reveal-on-consent. The nominator holds a code; presenting it lets them attach
 * their name so the recognition can be attributed. It is one-way and explicit —
 * nothing reveals a nominator without this call.
 */
async function revealNominator(id, accessCode, nominatorName) {
  const existing = await getById(id);
  if (!existing || !codeMatches(accessCode, existing.accessCodeHash)) {
    return { error: "No appreciation matches that reference and code" };
  }
  if (existing.revealed) {
    return { error: "This nomination has already been attributed" };
  }

  const name = String(nominatorName || "").trim().slice(0, 120);
  if (!name) {
    return { error: "A name is required to attribute this nomination" };
  }

  const updated = await updateAppreciation(id, (current) => ({
    ...current,
    nominatorName: name,
    revealed: true,
    revealedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));

  return { appreciation: updated };
}

function publicAppreciation(appreciation) {
  const { accessCodeHash, ...safe } = appreciation;
  return safe;
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
    revealed: list.filter((a) => a.revealed).length,
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

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  createAppreciation,
  listAppreciations,
  getById,
  updateAppreciation,
  revealNominator,
  publicAppreciation,
  buildAppreciationMetrics,
  suggestReplies
};
