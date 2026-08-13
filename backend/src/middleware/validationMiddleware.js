const { createHttpError } = require("./errorMiddleware");

const VALID_STATUSES = new Set(["open", "acknowledged", "resolved"]);
const VALID_AUTHOR_TYPES = new Set(["admin", "reporter"]);
const VALID_CHANNELS = new Set(["web", "email", "phone", "ussd", "mobile"]);

function normalizeText(value) {
  return String(value || "").trim();
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

  const channel = normalizeText(request.body?.channel || "web").toLowerCase();
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

  const authorType = normalizeText(request.body?.authorType || "admin").toLowerCase();
  if (!VALID_AUTHOR_TYPES.has(authorType)) {
    return next(createHttpError(400, "authorType must be admin or reporter"));
  }

  attachValidated(request, { messageText, authorType });
  return next();
}

module.exports = {
  validateLoginRequest,
  validateSubmissionRequest,
  validateStatusUpdateRequest,
  validateMessageRequest
};