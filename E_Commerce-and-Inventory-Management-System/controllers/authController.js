const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

const REFRESH_COOKIE_NAME = 'refreshToken';
// The cookie is only sent to the auth endpoints, never to the rest of the API
const REFRESH_COOKIE_PATH = '/api/auth';

const requireSecrets = () => {
  if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
    throw new AppError('Server misconfiguration: JWT secrets are not set', 500);
  }
};

const signAccessToken = (user) =>
  jwt.sign({ id: String(user._id), role: user.role }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    algorithm: 'HS256'
  });

// jwtid makes every refresh token unique, even when two are issued in the same second
const signRefreshToken = (user) =>
  jwt.sign({ id: String(user._id) }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    algorithm: 'HS256',
    jwtid: crypto.randomUUID()
  });

const issueTokens = (user) => {
  requireSecrets();
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const { exp } = jwt.decode(refreshToken);
  return { accessToken, refreshToken, refreshExpiresAt: new Date(exp * 1000) };
};

const cookieBaseOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax',
  path: REFRESH_COOKIE_PATH
});

const setRefreshCookie = (res, token, expiresAt) => {
  res.cookie(REFRESH_COOKIE_NAME, token, { ...cookieBaseOptions(), expires: expiresAt });
};

const clearRefreshCookie = (res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieBaseOptions());
};

// Refresh token may arrive in the HTTP-only cookie or in the request body
const readRefreshToken = (req) => {
  const token = (req.cookies && req.cookies[REFRESH_COOKIE_NAME]) || (req.body && req.body.refreshToken);
  return typeof token === 'string' && token.trim() ? token.trim() : null;
};

/**
 * POST /api/auth/register
 * Public registration always creates a "customer". Managers and admins are created by the seed script.
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};

  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    throw new AppError('name, email and password are required', 400, 'VALIDATION_ERROR');
  }

  const user = await User.create({ name, email, password, role: 'customer' });

  const { accessToken, refreshToken, refreshExpiresAt } = issueTokens(user);
  user.addRefreshToken(refreshToken, refreshExpiresAt);
  await user.save();

  setRefreshCookie(res, refreshToken, refreshExpiresAt);

  res.status(201).json({
    success: true,
    message: 'Registration successful',
    data: { user, accessToken, refreshToken }
  });
});

/**
 * POST /api/auth/login
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};

  // Reject non-string values so objects like { "$ne": null } never reach the query
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    throw new AppError('email and password are required', 400, 'VALIDATION_ERROR');
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password +refreshTokens');

  // Same message for unknown email and wrong password, so accounts cannot be enumerated
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }
  if (!user.isActive) {
    throw new AppError('Your account has been deactivated', 403, 'ACCOUNT_DEACTIVATED');
  }

  const { accessToken, refreshToken, refreshExpiresAt } = issueTokens(user);
  user.addRefreshToken(refreshToken, refreshExpiresAt);
  user.lastLoginAt = new Date();
  await user.save();

  setRefreshCookie(res, refreshToken, refreshExpiresAt);

  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: { user, accessToken, refreshToken }
  });
});

/**
 * POST /api/auth/refresh
 * Rotates the refresh token: the presented token is consumed and a new pair is issued.
 * Presenting a token that is validly signed but no longer stored means it was already used
 * (possible theft), so every session of that user is revoked.
 */
const refresh = asyncHandler(async (req, res) => {
  requireSecrets();

  const token = readRefreshToken(req);
  if (!token) {
    throw new AppError('Refresh token is required', 401, 'NO_REFRESH_TOKEN');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    clearRefreshCookie(res);
    if (err.name === 'TokenExpiredError') {
      throw new AppError('Refresh token expired. Please log in again.', 401, 'REFRESH_TOKEN_EXPIRED');
    }
    throw new AppError('Invalid refresh token', 401, 'REFRESH_TOKEN_INVALID');
  }

  const user = await User.findById(decoded.id).select('+refreshTokens');
  if (!user || !user.isActive) {
    clearRefreshCookie(res);
    throw new AppError('User no longer exists or is deactivated', 401, 'USER_NOT_FOUND');
  }

  if (!user.hasRefreshToken(token)) {
    user.revokeAllRefreshTokens();
    await user.save();
    clearRefreshCookie(res);
    throw new AppError(
      'Refresh token reuse detected. All sessions were revoked. Please log in again.',
      401,
      'REFRESH_TOKEN_REUSED'
    );
  }

  const { accessToken, refreshToken, refreshExpiresAt } = issueTokens(user);
  user.removeRefreshToken(token);
  user.addRefreshToken(refreshToken, refreshExpiresAt);
  await user.save();

  setRefreshCookie(res, refreshToken, refreshExpiresAt);

  res.status(200).json({
    success: true,
    message: 'Token refreshed',
    data: { accessToken, refreshToken }
  });
});

/**
 * POST /api/auth/logout
 * Revokes the presented refresh token (if valid) and always clears the cookie.
 */
const logout = asyncHandler(async (req, res) => {
  const token = readRefreshToken(req);

  if (token && process.env.JWT_REFRESH_SECRET) {
    try {
      // An expired token is still good enough to identify whose session to remove
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
        algorithms: ['HS256'],
        ignoreExpiration: true
      });
      const user = await User.findById(decoded.id).select('+refreshTokens');
      if (user) {
        user.removeRefreshToken(token);
        await user.save();
      }
    } catch (err) {
      // Invalid token: nothing to revoke. Logout still succeeds.
    }
  }

  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

/**
 * GET /api/auth/me
 */
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  res.status(200).json({ success: true, data: { user } });
});

module.exports = { register, login, refresh, logout, getMe };