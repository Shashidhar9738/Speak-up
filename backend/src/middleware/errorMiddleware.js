function createHttpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details) {
    error.details = details;
  }
  return error;
}

function notFoundHandler(request, response, next) {
  next(createHttpError(404, `Route not found: ${request.method} ${request.originalUrl}`));
}

function errorHandler(error, request, response, next) {
  const status = Number(error.status || 500);
  const payload = {
    error: error.message || "Internal server error"
  };

  if (error.details) {
    payload.details = error.details;
  }

  if (status >= 500) {
    console.error(error);
  }

  response.status(status).json(payload);
}

module.exports = {
  createHttpError,
  notFoundHandler,
  errorHandler
};