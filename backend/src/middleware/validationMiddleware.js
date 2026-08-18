const { createHttpError } = require("./errorMiddleware");

const VALID_STATUSES = new Set(["open", "acknowledged", "resolved"]);
const VALID_AUTHOR_TYPES = new Set(["admin", "reporter"]);
const VALID_CHANNELS = new Set(["web", "email", "phone", "ussd", "mobile"]);

/**
 * Read a JSON body or query field that is supposed to be text.
 *
 * Anything that is not a string becomes "", rather than being coerced into one.
 * A JSON body is attacker-shaped as easily as attacker-valued, and String()
 * turns the wrong shape into plausible text: String(["aaaaa", "bbbbb"]) is
 * "aaaaa,bbbbb", long enough to clear a minimum-length check and be stored as a
 * complaint; String({}) is "[object Object]". Query strings have the same hole
 * from the other direction, because ?email[]=a&email[]=b parses to an array.
 * Callers already treat "" as missing and answer with a 400, which is the right
 * answer for a field that arrived as the wrong type.
 */
function readText(value) {
  return typeof value === "string" ? value : "";
}

// Same, for the usual case where surrounding whitespace is not meaningful.
// Passwords use readText directly: trimming those would silently change the
// secret a caller supplied.
function normalizeText(value) {
  return readText(value).trim();
}

function attachValidated(request, values) {
  request.validated = {
    ...(request.validated || {}),
    ...values
  };
}

function validateLoginRequest(request, response, next) {
  const email = normalizeText(request.body?.email).toLowerCase();
  if (!email) {
    return next(createHttpError(400, "Email is required"));
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return next(createHttpError(400, "Email format is invalid"));
  }

  attachValidated(request, { email });
  return next();
}

function validateSubmissionRequest(request, response, next) {
  const messageText = normalizeText(request.body?.messageText);
  if (messageText.length < 10) {
    return next(createHttpError(400, "messageText must be at least 10 characters long"));
  }

  const channel = (normalizeText(request.body?.channel) || "web").toLowerCase();
  if (!VALID_CHANNELS.has(channel)) {
    return next(createHttpError(400, "channel must be one of web, email, phone, ussd, or mobile"));
  }

  attachValidated(request, {
    messageText,
    department: normalizeText(request.body?.department) || "Unspecified",
    region: normalizeText(request.body?.region) || "Unspecified",
    channel,
    browserLocale: normalizeText(request.body?.browserLocale) || "unknown"
  });
  return next();
}

function validateStatusUpdateRequest(request, response, next) {
  const status = normalizeText(request.body?.status).toLowerCase();
  if (!VALID_STATUSES.has(status)) {
    return next(createHttpError(400, "status must be open, acknowledged, or resolved"));
  }

  attachValidated(request, {
    status,
    note: normalizeText(request.body?.note)
  });
  return next();
}

function validateMessageRequest(request, response, next) {
  const messageText = normalizeText(request.body?.messageText);
  if (!messageText) {
    return next(createHttpError(400, "messageText is required"));
  }

  const authorType = (normalizeText(request.body?.authorType) || "admin").toLowerCase();
  if (!VALID_AUTHOR_TYPES.has(authorType)) {
    return next(createHttpError(400, "authorType must be admin or reporter"));
  }

  attachValidated(request, { messageText, authorType });
  return next();
}

module.exports = {
  readText,
  normalizeText,
  validateLoginRequest,
  validateSubmissionRequest,
  validateStatusUpdateRequest,
  validateMessageRequest
};