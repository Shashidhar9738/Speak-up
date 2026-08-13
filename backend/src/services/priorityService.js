/**
 * Keyword-driven priority.
 *
 * The tiers below are the single place that decides how urgent a complaint is.
 * They are deliberately explicit and exported so the dashboard can show a
 * reviewer *why* something came out P1 — a score with no explanation is not
 * something leadership can act on or challenge.
 *
 * Terms are STEMS matched on a word boundary, so "retaliat" catches
 * retaliation / retaliated / retaliating.
 */

const PRIORITY_TIERS = [
  {
    priority: "P1",
    label: "Critical — act immediately",
    colour: "#dc2626",
    colourLight: "#fdeeee",
    sla: "24 hours",
    description: "Safety, legal exposure, or someone at risk of harm.",
    terms: [
      "harass", "retaliat", "discriminat", "assault", "abus", "threat", "bully",
      "unsafe", "illegal", "fraud", "brib", "corrupt", "breach", "data leak",
      "sexual", "racis", "casteis", "molest", "violence", "suicid", "self harm",
      "whistleblow", "cover up", "coverup", "falsif", "forged",
      // Identity-based remarks are harassment however politely they are phrased.
      "accent", "religio", "caste", "gender", "ethnic", "disabilit", "pregnan",
      "slur", "derogat", "humiliat", "intimidat", "hostile"
    ]
  },
  {
    priority: "P2",
    label: "High — act this week",
    colour: "#d97706",
    colourLight: "#fef6e7",
    sla: "5 working days",
    description: "People are leaving, being underpaid, or being ignored.",
    terms: [
      "resign", "quit", "attrit", "leaving",
      // "notice" on its own: "handed in their notice" is the common phrasing and
      // "notice period" alone missed it entirely.
      "notice", "exit interview", "backfill", "headcount",
      "burnout", "burnt out", "exhaust", "overwork", "understaff",
      "unpaid", "underpaid", "withheld", "reimburs", "pending", "salary",
      "ignored", "no action", "nothing happened", "no response", "unresolved",
      "heard nothing", "no reply", "no update", "never responded", "still waiting",
      "repeatedly", "multiple times", "months", "escalat", "urgent", "immediately",
      "separate occasions", "out of pocket"
    ]
  },
  {
    priority: "P3",
    label: "Normal — schedule it",
    colour: "#2a78d6",
    colourLight: "#dbeafe",
    sla: "30 days",
    description: "Everything else — process, facilities, day-to-day friction.",
    terms: []
  }
];

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2 };

function stemPattern(terms) {
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("\\b(?:" + escaped.join("|") + ")\\w*", "gi");
}

const COMPILED = PRIORITY_TIERS
  .filter((tier) => tier.terms.length)
  .map((tier) => ({ ...tier, pattern: stemPattern(tier.terms) }));

/**
 * Returns the tier plus the exact words that triggered it, so the reason can be
 * shown next to the badge rather than left implicit.
 */
function classifyPriority(text, options) {
  const settings = options || {};
  const source = String(text || "");

  for (const tier of COMPILED) {
    tier.pattern.lastIndex = 0;
    const matches = source.match(tier.pattern) || [];
    if (matches.length) {
      const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
      return {
        priority: tier.priority,
        label: tier.label,
        colour: tier.colour,
        sla: tier.sla,
        matchedTerms: unique.slice(0, 6),
        reason: `Matched ${tier.priority} keyword${unique.length > 1 ? "s" : ""}: ${unique.slice(0, 3).join(", ")}`,
        // A numeric score keeps ordering stable inside a tier: more matches and
        // a negative tone push an item up its own band without changing tier.
        priorityScore: scoreWithin(tier.priority, unique.length, settings)
      };
    }
  }

  const fallback = PRIORITY_TIERS[PRIORITY_TIERS.length - 1];
  return {
    priority: fallback.priority,
    label: fallback.label,
    colour: fallback.colour,
    sla: fallback.sla,
    matchedTerms: [],
    reason: "No priority keywords matched",
    priorityScore: scoreWithin(fallback.priority, 0, settings)
  };
}

function scoreWithin(priority, matchCount, settings) {
  const base = { P1: 80, P2: 55, P3: 25 }[priority];
  const ceiling = { P1: 100, P2: 79, P3: 54 }[priority];
  let score = base + Math.min(matchCount * 4, 12);
  if (settings.sentiment === "negative") { score += 4; }
  if (settings.sensitiveCategory) { score += 4; }
  return Math.min(score, ceiling);
}

// Sorts most urgent first, then by score, then newest.
function comparePriority(left, right) {
  const tier = (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9);
  if (tier !== 0) { return tier; }
  const score = (right.priorityScore || 0) - (left.priorityScore || 0);
  if (score !== 0) { return score; }
  return new Date(right.createdAt) - new Date(left.createdAt);
}

function publicTiers() {
  return PRIORITY_TIERS.map((tier) => ({
    priority: tier.priority,
    label: tier.label,
    colour: tier.colour,
    colourLight: tier.colourLight,
    sla: tier.sla,
    description: tier.description,
    keywords: tier.terms
  }));
}

module.exports = {
  PRIORITY_TIERS,
  PRIORITY_ORDER,
  classifyPriority,
  comparePriority,
  publicTiers
};
