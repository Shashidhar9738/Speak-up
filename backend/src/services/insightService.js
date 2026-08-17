const db = require("./db");

/**
 * Operational and risk signals derived from reports.
 *
 * Two things here, both deliberately conservative:
 *
 *   Response times — the number a COO asks for. Timestamps already existed;
 *   nothing was measuring them.
 *
 *   Attrition risk — a SIGNAL, not a prediction. It says "look here", never
 *   "you will lose four people". A percentage would imply evidence that does
 *   not exist, and a CXO acting on a fabricated number is worse off than one
 *   acting on none.
 */

const RESIGNATION_TERMS = [
  "resign", "quit", "leaving", "notice", "another offer", "new job",
  "handed in", "last day", "exit interview", "moving on", "look elsewhere",
  "looking outside", "job hunt"
];

function median(values) {
  if (!values.length) { return null; }
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hoursBetween(from, to) {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
}

/**
 * Median rather than mean: one report left for three weeks would drag an
 * average enough to hide that most are answered the same day.
 */
function responseTimes(submissions, days) {
  const window = days || 30;
  const since = Date.now() - window * 86400000;
  const previousSince = since - window * 86400000;

  function measure(list) {
    const firstResponses = [];
    const resolutions = [];

    list.forEach((submission) => {
      const firstAdminReply = (submission.messages || [])
        .filter((m) => m.authorType === "admin")
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];

      if (firstAdminReply) {
        firstResponses.push(hoursBetween(submission.createdAt, firstAdminReply.createdAt));
      } else if (submission.status !== "open") {
        // A status change with no reply still counts as a response: someone
        // acted, they just did not write anything.
        firstResponses.push(hoursBetween(submission.createdAt, submission.updatedAt));
      }

      if (submission.status === "resolved") {
        resolutions.push(hoursBetween(submission.createdAt, submission.updatedAt));
      }
    });

    return {
      firstResponseHours: median(firstResponses),
      resolutionHours: median(resolutions),
      answered: firstResponses.length,
      resolved: resolutions.length,
      total: list.length
    };
  }

  const current = measure(submissions.filter((s) =>
    new Date(s.createdAt).getTime() >= since));
  const previous = measure(submissions.filter((s) => {
    const at = new Date(s.createdAt).getTime();
    return at >= previousSince && at < since;
  }));

  function direction(now, before) {
    if (now == null || before == null) { return "no_comparison"; }
    if (now < before * 0.85) { return "faster"; }
    if (now > before * 1.15) { return "slower"; }
    return "steady";
  }

  // Never answered at all is a separate failure from answered slowly, and the
  // median hides it entirely.
  const unanswered = submissions.filter((s) =>
    s.status === "open" && !(s.messages || []).some((m) => m.authorType === "admin"));

  return {
    windowDays: window,
    current,
    previous,
    firstResponseTrend: direction(current.firstResponseHours, previous.firstResponseHours),
    resolutionTrend: direction(current.resolutionHours, previous.resolutionHours),
    neverAnswered: unanswered.length,
    oldestUnanswered: unanswered.length
      ? Math.round(Math.max(...unanswered.map((s) =>
          hoursBetween(s.createdAt, new Date().toISOString()) / 24)))
      : 0
  };
}

/**
 * Attrition risk per department.
 *
 * Four inputs, each independently defensible, listed with the score so a
 * reader can disagree with the reasoning rather than only the conclusion.
 */
function attritionRisk(submissions, days) {
  const window = days || 90;
  const since = Date.now() - window * 86400000;
  const recent = submissions.filter((s) => new Date(s.createdAt).getTime() >= since);

  const byDepartment = {};
  recent.forEach((s) => {
    (byDepartment[s.department] = byDepartment[s.department] || []).push(s);
  });

  const pattern = new RegExp("\\b(?:" + RESIGNATION_TERMS.join("|") + ")\\w*", "i");

  return Object.entries(byDepartment)
    .filter(([department]) => department && department !== "Unspecified")
    .map(([department, items]) => {
      const reasons = [];
      let score = 0;

      const mentioningExit = items.filter((s) => pattern.test(s.messageText || ""));
      if (mentioningExit.length) {
        score += mentioningExit.length * 18;
        reasons.push(`${mentioningExit.length} report${mentioningExit.length > 1 ? "s" : ""} mention leaving`);
      }

      const unresolved = items.filter((s) => s.status !== "resolved");
      if (unresolved.length >= 3) {
        score += unresolved.length * 5;
        reasons.push(`${unresolved.length} still unresolved`);
      }

      const negative = items.filter((s) => s.sentiment === "negative");
      const negativeShare = items.length ? negative.length / items.length : 0;
      if (negativeShare > 0.6 && items.length >= 3) {
        score += Math.round(negativeShare * 25);
        reasons.push(`${Math.round(negativeShare * 100)}% negative in tone`);
      }

      // Being ignored is its own driver of leaving, separate from the
      // complaint itself.
      const breached = unresolved.filter((s) => {
        const targetHours = { P1: 24, P2: 120, P3: 720 }[s.priority] || 720;
        return hoursBetween(s.createdAt, new Date().toISOString()) > targetHours;
      });
      if (breached.length) {
        score += breached.length * 8;
        reasons.push(`${breached.length} past the response target`);
      }

      const level = score >= 60 ? "elevated" : score >= 30 ? "watch" : "normal";

      return {
        department,
        level,
        score: Math.min(score, 100),
        reports: items.length,
        mentioningExit: mentioningExit.length,
        unresolved: unresolved.length,
        reasons,
        // The wording matters: this points somewhere to look, it does not
        // forecast anything.
        summary: reasons.length
          ? `${department}: ${reasons.join(", ")}.`
          : `${department}: nothing standing out.`
      };
    })
    .filter((entry) => entry.level !== "normal")
    .sort((a, b) => b.score - a.score);
}

function build(submissions, options) {
  const settings = options || {};
  return {
    responseTimes: responseTimes(submissions, settings.responseDays),
    attritionRisk: attritionRisk(submissions, settings.riskDays),
    caveat: "Attrition risk is a signal for where to look, not a forecast. " +
            "It is derived from complaint language and handling, not from HR data."
  };
}

module.exports = { build, responseTimes, attritionRisk, median, RESIGNATION_TERMS };
