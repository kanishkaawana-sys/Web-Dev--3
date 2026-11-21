const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { AppError, asyncHandler } = require('./errorHandler');

/**
 * Strips an optional "Bearer " prefix. Used for Socket.IO, where the token may be sent raw.
 */
const extractBearerToken = (value) => {
  if (!value || typeof value !== 'string') return null;
  const token = value.trim().replace(/^Bearer\s+/i, '').trim();
  return token || null;
};

/**
 * Verifies an access token and loads the user it belongs to.
 * Shared by the HTTP `protect` middleware and the Socket.IO handshake.
 * The role is read from the database (not the token), so role changes and
 * deactivation take effect immediately.
 */
const authenticateToken = async (token) => {
  if (!process.env.JWT_ACCESS_SECRET) {
    throw new AppError('Server misconfiguration: JWT_ACCESS_SECRET is not set', 500);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AppError('Access token expired', 401, 'TOKEN_EXPIRED');
    }
    throw new AppError('Invalid access token', 401, 'TOKEN_INVALID');
  }

  const user = await User.findById(decoded.id).select('name email role isActive');
  if (!user) {
    throw new AppError('The user belonging to this token no longer exists', 401, 'USER_NOT_FOUND');
  }
  if (!user.isActive) {
    throw new AppError('Your account has been deactivated', 403, 'ACCOUNT_DEACTIVATED');
  }

  return user;
};

/**
 * Requires a valid "Authorization: Bearer <accessToken>" header.
 * Attaches the user document to req.user (fields: _id, id, name, email, role).
 */
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new AppError('Authentication required. Provide a Bearer access token.', 401, 'NO_TOKEN');
  }

  req.user = await authenticateToken(match[1].trim());
  next();
});

module.exports = { protect, authenticateToken, extractBearerToken };