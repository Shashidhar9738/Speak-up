const crypto = require("crypto");
const config = require("../config");
const audit = require("./auditService");

/**
 * Outbound webhooks — for HRIS, ticketing, or anything else that wants to know
 * when something happens.
 *
 * Deliberately generic rather than written against one HRIS. Workday,
 * Darwinbox and SAP all differ, and coding to one guesses wrong for the other
 * two. This posts a documented JSON envelope to a URL you configure; a small
 * adapter on the receiving side is far less work than a wrong integration here.
 *
 *   SPEAKUP_WEBHOOK_URL=https://hris.example.com/hooks/speakup
 *   SPEAKUP_WEBHOOK_SECRET=<shared secret>
 *   SPEAKUP_WEBHOOK_EVENTS=submission.created,submission.escalated
 *
 * WHAT IS SENT, AND WHAT IS NOT
 * -----------------------------
 * Never the complaint text, and never the access code. A webhook leaves the
 * building and often lands in a system with different access rules, so it
 * carries only the metadata needed to open a ticket: id, category, priority,
 * department, status. Anyone wanting the substance must come back and read it
 * here, where the role rules still apply.
 */

const EVENTS = {
  CREATED: "submission.created",
  ESCALATED: "submission.escalated",
  STATUS: "submission.status_changed",
  RESOLVED: "submission.resolved"
};

function isConfigured() {
  return Boolean(config.webhookUrl);
}

function wants(event) {
  if (!isConfigured()) { return false; }
  if (!config.webhookEvents.length) { return true; }
  return config.webhookEvents.includes(event);
}

/**
 * HMAC over the exact bytes sent, so the receiver can verify the payload came
 * from us and was not altered. Without it any host that learns the URL can
 * post convincing events.
 */
function sign(body) {
  if (!config.webhookSecret) { return null; }
  return "sha256=" + crypto.createHmac("sha256", config.webhookSecret).update(body).digest("hex");
}

// Only fields safe to leave the building.
function safePayload(submission) {
  return {
    id: submission.id,
    category: submission.category,
    priority: submission.priority,
    sla: submission.sla,
    status: submission.status,
    department: submission.department,
    region: submission.region,
    sensitive: Boolean(submission.flags?.sensitive),
    escalated: Boolean(submission.escalated),
    escalatedTo: submission.escalatedTo || null,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt
  };
}

async function emit(event, submission, extra) {
  if (!wants(event)) { return { sent: false, reason: "not configured for this event" }; }

  const body = JSON.stringify({
    event,
    sentAt: new Date().toISOString(),
    source: "speakup",
    submission: safePayload(submission),
    ...(extra || {})
  });

  const headers = { "Content-Type": "application/json", "User-Agent": "SpeakUp-Webhook/1" };
  const signature = sign(body);
  if (signature) { headers["X-SpeakUp-Signature"] = signature; }

  try {
    // A slow endpoint must not hold up the person who filed the report.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs);

    const response = await fetch(config.webhookUrl, {
      method: "POST", headers, body, signal: controller.signal
    });
    clearTimeout(timer);

    audit.record("webhook.sent", "system", { event, id: submission.id, status: response.status });
    return { sent: response.ok, status: response.status };
  } catch (error) {
    // Never fail the originating request over a webhook: a complaint being
    // recorded matters more than an HRIS hearing about it promptly.
    console.warn(`[speakup] webhook ${event} failed: ${error.message}`);
    audit.record("webhook.failed", "system", { event, id: submission.id, error: error.message });
    return { sent: false, reason: error.message };
  }
}

/** Fire-and-forget: callers should not await this on a request path. */
function emitAsync(event, submission, extra) {
  emit(event, submission, extra).catch(() => {});
}

function describe() {
  return {
    configured: isConfigured(),
    url: isConfigured() ? config.webhookUrl.replace(/\/\/[^@]*@/, "//***@") : null,
    signed: Boolean(config.webhookSecret),
    events: config.webhookEvents.length ? config.webhookEvents : Object.values(EVENTS),
    payloadFields: Object.keys(safePayload({ flags: {} })),
    neverSent: ["messageText", "summary", "keywords", "accessCodeHash", "messages"]
  };
}

module.exports = { EVENTS, isConfigured, emit, emitAsync, describe, safePayload };
