const { AppError } = require('./errorHandler');

const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  MANAGER: 'manager',
  ADMIN: 'admin'
});

/**
 * Role-Based Access Control. Must run after `protect`.
 * Usage: router.post('/', protect, authorize('admin', 'manager'), handler)
 */
const authorize = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return next(new AppError('Authentication required', 401, 'NO_TOKEN'));
  }

  if (!allowedRoles.includes(req.user.role)) {
    return next(
      new AppError(
        `Access denied. Role "${req.user.role}" is not permitted to perform this action.`,
        403,
        'FORBIDDEN'
      )
    );
  }

  return next();
};

module.exports = { authorize, ROLES };