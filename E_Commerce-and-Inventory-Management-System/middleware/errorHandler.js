/**
 * Operational error with an HTTP status code. Throw it from controllers and middleware.
 * code is an optional machine-readable string (e.g. TOKEN_EXPIRED) for API clients.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Wraps an async route handler so rejected promises reach the error middleware.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * 404 handler for unknown routes. Mount after all routers.
 */
const notFound = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND'));
};

/**
 * Global error handler. Mount last. Every error response uses the shape:
 * { success: false, message, code?, errors?, stack? }
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let code = err.code && typeof err.code === 'string' ? err.code : null;
  let errors = err.details || null;

  if (err.name === 'ValidationError' && err.errors) {
    // Mongoose schema validation
    statusCode = 400;
    message = 'Validation failed';
    code = 'VALIDATION_ERROR';
    errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err.name === 'CastError') {
    // Malformed ObjectId or wrong value type
    statusCode = 400;
    message = `Invalid value for "${err.path}": ${err.value}`;
    code = 'INVALID_ID';
  } else if (err.code === 11000) {
    // MongoDB duplicate key
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `A record with this ${field} already exists`;
    code = 'DUPLICATE_KEY';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
    code = 'TOKEN_EXPIRED';
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
    code = 'TOKEN_INVALID';
  } else if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Malformed JSON in request body';
    code = 'INVALID_JSON';
  } else if (err.type === 'entity.too.large') {
    statusCode = 413;
    message = 'Request body is too large';
    code = 'PAYLOAD_TOO_LARGE';
  }

  if (statusCode >= 500) {
    console.error(`[ERROR] ${req.method} ${req.originalUrl} -> ${err.stack || err}`);
    if (process.env.NODE_ENV === 'production' && !err.isOperational) {
      message = 'Internal Server Error';
    }
  }

  const body = { success: false, message };
  if (code) body.code = code;
  if (errors) body.errors = errors;
  if (process.env.NODE_ENV !== 'production' && statusCode >= 500) {
    body.stack = err.stack;
  }

  return res.status(statusCode).json(body);
};

module.exports = { AppError, asyncHandler, notFound, errorHandler };