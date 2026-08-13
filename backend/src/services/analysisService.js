const crypto = require("crypto");
const { classifyPriority } = require("./priorityService");

// Terms are stored as STEMS and matched with a word-boundary prefix regex, so
// "pressur" catches pressure / pressured / pressuring. The previous version used
// substring includes() on whole words, which silently missed every inflection:
// "pressuring" does not contain "pressure".
const CATEGORY_RULES = [
  { name: "Harassment & Ethics", terms: ["harass", "bias", "discrimin", "abus", "threat", "retaliat", "ethic", "misconduct", "bully", "hostil", "inappropri", "assault", "racis", "sexis"] },
  // "pay" and "compensat" are avoided: bare "pay" swallowed "overtime pay" and
  // "compensat" swallowed "compensatory time off", pulling workload complaints
  // into the payroll bucket. The narrower stems below still catch real cases.
  { name: "Payroll & Benefits", terms: ["salar", "payroll", "payment", "reimburs", "bonus", "benefit", "compensation", "increment", "appraisal", "wage", "insurance", "provident", "payslip", "underpaid"] },
  { name: "Workload", terms: ["burnout", "overtime", "weekend", "workload", "capacit", "pressur", "overwork", "understaff", "deadline", "crunch", "exhaust", "bandwidth"] },
  { name: "Management", terms: ["manager", "leadership", "supervisor", "onboard", "feedback", "promot", "micromanag", "favorit", "favourit", "mentor", "skip-level", "appraiser"] },
  // "polic" is deliberately absent: it matched benign HR prose like "flexible
  // hours policy" and dragged it into a compliance bucket. "complian" and
  // "regulat" cover the cases that matter.
  { name: "Security & Compliance", terms: ["securit", "complian", "fraud", "brib", "leak", "audit", "confidential", "breach", "gdpr", "regulat", "whistleblow"] },
  { name: "Facilities & IT", terms: ["laptop", "system", "office", "access", "network", "wifi", "tool", "hardware", "software", "cafeteria", "parking", "washroom", "hvac", "aircon", "building", "conditioning", "temperatur", "facilit", "restroom", "elevator", "canteen", "seating", "desk", "pantry", "hygien", "ventilat"] }
];

const POSITIVE_TERMS = ["good", "great", "excellent", "support", "help", "resolv", "smooth", "appreciat", "thank", "happ", "improv", "flexib", "transparen", "respect", "fair", "recogni"];
const NEGATIVE_TERMS = ["bad", "delay", "burnout", "harass", "issue", "urgent", "risk", "toxic", "threat", "pressur", "pending", "unfair", "ignor", "worse", "worst", "frustrat", "poor", "fail", "refus", "deni", "stress", "anxi", "unrealist", "arbitrar", "disparit", "stagnat", "attrit", "resign", "morale", "conflict", "crash", "broken", "unbearab", "inaction", "favorit", "favourit", "forced", "unpaid", "overwork", "understaff", "micromanag", "discrimin", "retaliat", "bully", "hostil", "inappropri", "complain", "concern", "disappoint", "neglect", "overlook", "exclud", "unaddress", "unresolv"];
const URGENT_TERMS = ["urgent", "retaliat", "harass", "fraud", "abus", "threat", "burnout", "securit", "immediate", "emergenc", "unsafe", "illegal", "assault"];
const SPAM_TERMS = ["buy now", "free money", "crypto", "casino", "click here", "limited offer", "viagra", "lottery", "make money", "work from home opportunity"];

// Negators flip the sentiment of a term appearing shortly after them, so
// "not supportive" no longer registers as positive.
const NEGATORS = ["not", "no", "never", "nothing", "without", "isnt", "isn't", "wasnt", "wasn't", "dont", "don't", "didnt", "didn't", "cant", "can't", "wont", "won't", "hardly", "barely", "lack", "lacks", "lacking"];

// A word cloud built from "after / getting / every" is noise. This list covers
// function words plus the filler that dominates complaint prose.
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "have", "has", "had", "been", "being", "your", "you", "our", "their", "them", "they", "there", "here", "about", "without", "into", "are", "was", "were", "but", "not", "too", "very", "all", "any", "can", "will", "just", "would", "could", "should", "when", "what", "which", "who", "whom", "whose", "how", "why", "where", "than", "then", "some", "such", "only", "also", "more", "most", "much", "many", "even", "ever", "every", "each", "other", "another", "same", "own", "get", "got", "getting", "give", "gave", "given", "make", "made", "making", "take", "took", "taken", "taking", "come", "came", "coming", "went", "going", "goes", "say", "said", "says", "see", "saw", "seen", "know", "known", "knew", "think", "thought", "want", "wanted", "need", "needed", "let", "put", "keep", "kept", "still", "back", "over", "under", "after", "before", "while", "during", "since", "until", "again", "once", "now", "new", "old", "one", "two", "three", "last", "next", "first", "second", "day", "days", "week", "weeks", "month", "months", "year", "years", "time", "times", "thing", "things", "way", "ways", "lot", "lots", "bit", "really", "actually", "basically", "literally", "simply", "quite", "rather", "well", "like", "sure", "maybe", "perhaps", "please", "thanks", "thank", "hello", "everyone", "anyone", "someone", "nobody", "somebody", "everything", "anything", "nothing", "myself", "himself", "herself", "themselves", "its", "his", "her", "him", "she", "hers", "mine", "ours", "yours", "was", "does", "did", "doing", "done", "having", "am", "is", "be", "were", "with", "per", "via", "etc"
]);

// Build once: /\b(?:harass|bias|...)\w*/gi
function toStemPattern(terms) {
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("\\b(?:" + escaped.join("|") + ")\\w*", "gi");
}

const CATEGORY_PATTERNS = CATEGORY_RULES.map((rule) => ({ name: rule.name, pattern: toStemPattern(rule.terms) }));
const POSITIVE_PATTERN = toStemPattern(POSITIVE_TERMS);
const NEGATIVE_PATTERN = toStemPattern(NEGATIVE_TERMS);
const URGENT_PATTERN = toStemPattern(URGENT_TERMS);

function countMatches(text, pattern) {
  pattern.lastIndex = 0;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
    .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

function pickCategory(text) {
  let bestCategory = "General";
  let bestScore = 0;

  for (const rule of CATEGORY_PATTERNS) {
    const score = countMatches(text, rule.pattern);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.name;
    }
  }

  return bestCategory;
}

function summarize(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 160) {
    return cleaned;
  }
  // Prefer cutting at a sentence or word boundary rather than mid-word.
  const window = cleaned.slice(0, 157);
  const sentenceEnd = window.lastIndexOf(". ");
  if (sentenceEnd > 90) {
    return window.slice(0, sentenceEnd + 1);
  }
  const wordEnd = window.lastIndexOf(" ");
  return `${window.slice(0, wordEnd > 0 ? wordEnd : 157).trim()}...`;
}

/**
 * Key phrases, not bare tokens: adjacent non-stop-word pairs ("weekend work",
 * "salary adjustment") carry the meaning a CXO scans for. Bigrams outrank
 * single words, and words that drove the category are boosted.
 */
function extractKeywords(text, category) {
  const tokens = tokenize(text);
  if (!tokens.length) {
    return [];
  }

  const categoryRule = CATEGORY_PATTERNS.find((rule) => rule.name === category);
  const scores = new Map();

  function add(phrase, weight) {
    scores.set(phrase, (scores.get(phrase) || 0) + weight);
  }

  const raw = text.toLowerCase();
  tokens.forEach((token) => {
    let weight = 1;
    if (categoryRule) {
      categoryRule.pattern.lastIndex = 0;
      if (categoryRule.pattern.test(token)) {
        weight += 2;
      }
    }
    NEGATIVE_PATTERN.lastIndex = 0;
    if (NEGATIVE_PATTERN.test(token)) {
      weight += 1;
    }
    add(token, weight);
  });

  // Bigrams from the original word order, keeping only pairs that actually
  // appear adjacently in the source text.
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const phrase = tokens[index] + " " + tokens[index + 1];
    if (raw.includes(phrase)) {
      add(phrase, 3);
    }
  }

  const ranked = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([phrase]) => phrase);

  // Drop single words already covered by a higher-ranked phrase.
  const chosen = [];
  for (const phrase of ranked) {
    if (chosen.length >= 5) {
      break;
    }
    const covered = chosen.some((existing) => existing.includes(phrase) || phrase.includes(existing));
    if (!covered) {
      chosen.push(phrase);
    }
  }

  return chosen;
}

function analyzeSentiment(text) {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z']+/g) || [];
  let positive = 0;
  let negative = 0;

  words.forEach((word, index) => {
    POSITIVE_PATTERN.lastIndex = 0;
    NEGATIVE_PATTERN.lastIndex = 0;
    const isPositive = POSITIVE_PATTERN.test(word);
    const isNegative = NEGATIVE_PATTERN.test(word);
    if (!isPositive && !isNegative) {
      return;
    }

    // Look back up to three words for a negator.
    const start = Math.max(0, index - 3);
    const negated = words.slice(start, index).some((previous) => NEGATORS.includes(previous));

    if (isPositive) {
      negated ? (negative += 1) : (positive += 1);
    } else {
      negated ? (positive += 1) : (negative += 1);
    }
  });

  if (negative > positive) {
    return "negative";
  }
  if (positive > negative) {
    return "positive";
  }
  return "neutral";
}

function derivePriority(category, sentiment, text) {
  const urgentHits = countMatches(text, URGENT_PATTERN);
  let score = 30;

  if (sentiment === "negative") {
    score += 20;
  }
  if (sentiment === "positive") {
    score -= 15;
  }
  if (category === "Harassment & Ethics" || category === "Security & Compliance") {
    score += 30;
  }
  if (category === "Workload" || category === "Payroll & Benefits") {
    score += 15;
  }

  score += urgentHits * 10;
  score = Math.max(0, Math.min(score, 100));

  if (score >= 80) {
    return { priority: "P1", priorityScore: score };
  }
  if (score >= 55) {
    return { priority: "P2", priorityScore: score };
  }
  return { priority: "P3", priorityScore: score };
}

function detectFlags(text, category) {
  const normalized = text.toLowerCase();
  const spam = SPAM_TERMS.some((term) => normalized.includes(term)) || normalized.length < 15;
  const urgent = countMatches(text, URGENT_PATTERN) > 0;
  const sensitive = category === "Harassment & Ethics" || category === "Security & Compliance";
  return { spam, urgent, sensitive };
}

/**
 * Reporter access code. The plaintext is returned to the reporter exactly once
 * at submission time and never stored — only its hash — so a stolen datastore
 * cannot be used to impersonate reporters or enumerate their threads.
 */
function createTicketId() {
  // Crockford-style alphabet: no I/L/O/U, so nothing is misread when typed in.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.randomBytes(8);
  let body = "";
  for (let index = 0; index < 8; index += 1) {
    body += alphabet[bytes[index] % alphabet.length];
  }
  return `TKT-${body.slice(0, 4)}-${body.slice(4)}`;
}

function createAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  const bytes = crypto.randomBytes(10);
  let body = "";
  for (let index = 0; index < 10; index += 1) {
    body += alphabet[bytes[index] % alphabet.length];
  }
  return `SPK-${body.slice(0, 5)}-${body.slice(5)}`;
}

function hashAccessCode(accessCode) {
  return crypto.createHash("sha256").update(String(accessCode).trim().toUpperCase()).digest("hex");
}

function analyzeSubmission(input) {
  const messageText = String(input.messageText || "").trim();
  const category = pickCategory(messageText);
  const sentiment = analyzeSentiment(messageText);
  const summary = summarize(messageText);
  const keywords = extractKeywords(messageText, category);
  const flags = detectFlags(messageText, category);
  const verdict = classifyPriority(messageText, {
    sentiment,
    sensitiveCategory: flags.sensitive
  });
  const accessCode = createAccessCode();

  return {
    submission: {
      id: createTicketId(),
      messageText,
      summary,
      category,
      keywords,
      sentiment,
      priority: verdict.priority,
      priorityScore: verdict.priorityScore,
      priorityLabel: verdict.label,
      priorityColour: verdict.colour,
      priorityReason: verdict.reason,
      priorityTerms: verdict.matchedTerms,
      sla: verdict.sla,
      status: "open",
      // Spam is held out of dashboards and metrics instead of polluting the
      // word cloud and alert counts. Admins can still opt in with includeSpam.
      quarantined: flags.spam,
      department: input.department || "Unspecified",
      region: input.region || "Unspecified",
      channel: input.channel || "web",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      flags,
      messages: [],
      accessCodeHash: hashAccessCode(accessCode),
      metadata: {
        browserLocale: input.browserLocale || "unknown"
      }
    },
    accessCode
  };
}

function isoWeekKey(dateText) {
  const date = new Date(dateText);
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function buildMetrics(submissions) {
  const sorted = [...submissions].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const total = sorted.length;
  const statusCounts = { open: 0, acknowledged: 0, resolved: 0 };
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const categoryCounts = {};
  const keywordCounts = {};
  const departmentHeatmap = {};
  const trend = {};

  for (const submission of sorted) {
    const week = isoWeekKey(submission.createdAt);
    statusCounts[submission.status] = (statusCounts[submission.status] || 0) + 1;
    sentimentCounts[submission.sentiment] = (sentimentCounts[submission.sentiment] || 0) + 1;
    categoryCounts[submission.category] = (categoryCounts[submission.category] || 0) + 1;
    trend[week] = (trend[week] || 0) + 1;

    if (!departmentHeatmap[submission.department]) {
      departmentHeatmap[submission.department] = {};
    }
    departmentHeatmap[submission.department][week] = (departmentHeatmap[submission.department][week] || 0) + 1;

    for (const keyword of submission.keywords || []) {
      keywordCounts[keyword] = (keywordCounts[keyword] || 0) + 1;
    }
  }

  const topKeywords = Object.entries(keywordCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([keyword, count]) => ({ keyword, count }));

  const priorityIssues = sorted
    .filter((submission) => submission.status !== "resolved")
    .sort((left, right) => right.priorityScore - left.priorityScore || new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, 8)
    .map((submission) => ({
      id: submission.id,
      title: submission.category,
      summary: submission.summary,
      priority: submission.priority,
      priorityScore: submission.priorityScore,
      status: submission.status,
      createdAt: submission.createdAt,
      department: submission.department
    }));

  return {
    totals: {
      submissions: total,
      open: statusCounts.open,
      acknowledged: statusCounts.acknowledged,
      resolved: statusCounts.resolved
    },
    statusCounts,
    sentimentCounts,
    categoryCounts,
    topKeywords,
    weeklyTrend: Object.entries(trend)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([week, count]) => ({ week, count })),
    departmentHeatmap,
    priorityIssues,
    latestSubmissions: sorted.slice(0, 10)
  };
}

module.exports = {
  analyzeSubmission,
  createTicketId,
  buildMetrics,
  createAccessCode,
  hashAccessCode
};
