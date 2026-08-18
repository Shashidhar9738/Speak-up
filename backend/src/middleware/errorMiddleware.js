const SERVER_ERROR_MESSAGE = "Internal server error";

// `expose` marks a message as written for the caller. Errors that reach the
// handler without it came from somewhere else — a database driver, a parser, an
// email client — and their messages can carry connection strings, query text or
// file paths, so they are logged but never sent downstream.
function createHttpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  if (details) {
    error.details = details;
  }
  return error;
}

// response.status() throws on anything outside 100-999, which would crash the
// handler whose whole job is to keep the process alive. Anything unrecognisable
// is treated as an internal failure.
function toStatus(value) {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return 500;
  }
  return status;
}

function notFoundHandler(request, response, next) {
  next(createHttpError(404, `Route not found: ${request.method} ${request.originalUrl}`));
}

function errorHandler(error, request, response, next) {
  const status = toStatus(error.status);
  const expose = error.expose === true || status < 500;

  if (status >= 500) {
    console.error(error);
  }

  const payload = {
    error: (expose && error.message) || SERVER_ERROR_MESSAGE
  };

  if (expose && error.details) {
    payload.details = error.details;
  }

  response.status(status).json(payload);
}

module.exports = {
  createHttpError,
  notFoundHandler,
  errorHandler
};