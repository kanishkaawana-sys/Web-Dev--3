const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const MAX_ACTIVE_SESSIONS = 5;

const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [60, 'Name cannot exceed 60 characters']
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address']
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false
    },
    role: {
      type: String,
      enum: {
        values: ['customer', 'manager', 'admin'],
        message: 'Role must be one of: customer, manager, admin'
      },
      default: 'customer'
    },
    isActive: {
      type: Boolean,
      default: true
    },
    refreshTokens: {
      type: [refreshTokenSchema],
      default: [],
      select: false
    },
    lastLoginAt: {
      type: Date
    }
  },
  { timestamps: true }
);

// Hash the password with bcrypt whenever it is new or changed
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const rounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 10;
  this.password = await bcrypt.hash(this.password, rounds);
});

// Compare a plain-text password with the stored hash (query must use .select('+password'))
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) {
    throw new Error('Password hash not loaded. Query the user with .select("+password").');
  }
  return bcrypt.compare(candidatePassword, this.password);
};

// SHA-256 digest of a refresh token. Only the digest is stored, never the raw token.
userSchema.statics.hashToken = function (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
};

// Adds a refresh token (hashed) to the in-memory document. Caller must save().
// Requires the document to be loaded with .select('+refreshTokens').
userSchema.methods.addRefreshToken = function (token, expiresAt) {
  const now = new Date();
  const active = (this.refreshTokens || []).filter((t) => t.expiresAt > now);
  active.push({ tokenHash: this.constructor.hashToken(token), expiresAt });
  // Keep only the most recent sessions
  this.refreshTokens = active.slice(-MAX_ACTIVE_SESSIONS);
};

// True when the raw token matches a stored, unexpired hash
userSchema.methods.hasRefreshToken = function (token) {
  const hash = this.constructor.hashToken(token);
  const now = new Date();
  return (this.refreshTokens || []).some((t) => t.tokenHash === hash && t.expiresAt > now);
};

// Removes one refresh token (used on rotation and logout). Caller must save().
userSchema.methods.removeRefreshToken = function (token) {
  const hash = this.constructor.hashToken(token);
  this.refreshTokens = (this.refreshTokens || []).filter((t) => t.tokenHash !== hash);
};

// Revokes every session (used when refresh-token reuse is detected). Caller must save().
userSchema.methods.revokeAllRefreshTokens = function () {
  this.refreshTokens = [];
};

// Never leak sensitive fields in API responses
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.refreshTokens;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('User', userSchema);