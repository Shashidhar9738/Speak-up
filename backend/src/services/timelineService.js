const db = require("./db");

/**
 * Case timeline.
 *
 * Every event already existed — created_at, the message thread, escalation
 * stamps, notifications — but scattered across four places, so nobody could
 * see a report as a sequence. This assembles them in order.
 *
 * Reconstructed from stored facts rather than kept as its own event log: a
 * second log would drift from the records it describes, and the drift would be
 * invisible. The cost is that only the latest status change is known, which is
 * stated rather than papered over.
 */

const STAGES = [
  { key: "submitted", label: "Submitted", icon: "ti-pencil-plus" },
  { key: "seen", label: "Seen by leadership", icon: "ti-eye" },
  { key: "in_review", label: "Under review", icon: "ti-search" },
  { key: "action", label: "Action taken", icon: "ti-tool" },
  { key: "resolved", label: "Resolved", icon: "ti-circle-check" }
];

function build(submission) {
  if (!submission) { return { events: [], stages: [], currentStage: null }; }

  const events = [];

  events.push({
    at: submission.createdAt,
    kind: "submitted",
    title: "Report submitted",
    detail: `${submission.category} · ${submission.priority} · target ${submission.sla || "unset"}`,
    actor: "anonymous"
  });

  if (submission.editedAt) {
    events.push({
      at: submission.editedAt,
      kind: "edited",
      title: "Reporter edited their report",
      detail: submission.editCount > 1 ? `${submission.editCount} edits` : "Re-analysed after the change",
      actor: "anonymous"
    });
  }

  (submission.messages || []).forEach((message) => {
    events.push({
      at: message.createdAt,
      kind: message.authorType === "admin" ? "reply_admin" : "reply_reporter",
      title: message.authorType === "admin" ? "Leadership replied" : "Reporter replied",
      // The thread is shown in full elsewhere; the timeline is a spine, not a
      // second copy of the conversation.
      detail: message.messageText.length > 90
        ? `${message.messageText.slice(0, 87)}...`
        : message.messageText,
      actor: message.authorType
    });
  });

  if (submission.escalatedAt) {
    events.push({
      at: submission.escalatedAt,
      kind: "escalated",
      title: `Escalated to ${submission.escalatedTo}`,
      detail: submission.escalationNote || "",
      actor: submission.escalatedBy || "admin"
    });
  }

  // Only the latest status change survives in the record. Claiming to know
  // when it was acknowledged as well would be inventing history.
  if (submission.status !== "open") {
    events.push({
      at: submission.updatedAt,
      kind: submission.status === "resolved" ? "resolved" : "acknowledged",
      title: submission.status === "resolved" ? "Marked resolved" : "Acknowledged by leadership",
      detail: submission.statusNote || "",
      actor: "admin",
      approximate: true
    });
  }

  events.sort((left, right) => new Date(left.at) - new Date(right.at));

  return {
    events,
    stages: stagesFor(submission),
    currentStage: currentStage(submission),
    elapsedDays: Math.max(0,
      Math.round((Date.now() - new Date(submission.createdAt).getTime()) / 86400000))
  };
}

/**
 * The reporter-facing view: five plain stages rather than internal statuses.
 * "Seen by leadership" is a real, checkable fact — the audit trail records
 * reads — and it is the single thing a nervous reporter most wants to know.
 */
function stagesFor(submission) {
  const hasAdminReply = (submission.messages || []).some((m) => m.authorType === "admin");
  const reached = {
    submitted: true,
    seen: submission.status !== "open" || hasAdminReply || Boolean(submission.escalated),
    in_review: submission.status === "acknowledged" || Boolean(submission.escalated) || hasAdminReply,
    action: Boolean(submission.escalated) || submission.status === "resolved",
    resolved: submission.status === "resolved"
  };

  return STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    icon: stage.icon,
    reached: reached[stage.key]
  }));
}

function currentStage(submission) {
  const stages = stagesFor(submission);
  const reached = stages.filter((s) => s.reached);
  return reached.length ? reached[reached.length - 1].key : "submitted";
}

/**
 * SLA position. Returned as a deadline rather than a countdown so the client
 * can tick without asking the server, and so a stale response cannot make a
 * breached case look like it still has time.
 */
function slaStatus(submission) {
  const hours = { P1: 24, P2: 120, P3: 720 }[submission.priority] || 720;
  const due = new Date(submission.createdAt).getTime() + hours * 3600000;
  const remainingMs = due - Date.now();
  const settled = submission.status === "resolved";

  return {
    dueAt: new Date(due).toISOString(),
    targetHours: hours,
    remainingMs: settled ? null : remainingMs,
    breached: !settled && remainingMs < 0,
    // A quarter of the window left is the point at which it is still possible
    // to act; flagging at the moment of breach is too late to be useful.
    atRisk: !settled && remainingMs > 0 && remainingMs < hours * 3600000 * 0.25,
    settled
  };
}

module.exports = { STAGES, build, stagesFor, currentStage, slaStatus };
