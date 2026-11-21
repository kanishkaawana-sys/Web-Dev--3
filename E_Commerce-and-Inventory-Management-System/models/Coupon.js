const mongoose = require('mongoose');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Coupon code is required'],
      unique: true,
      uppercase: true,
      trim: true,
      minlength: [3, 'Coupon code must be at least 3 characters'],
      maxlength: [30, 'Coupon code cannot exceed 30 characters']
    },
    description: {
      type: String,
      trim: true,
      maxlength: [200, 'Description cannot exceed 200 characters'],
      default: ''
    },
    discountType: {
      type: String,
      required: [true, 'Discount type is required'],
      enum: {
        values: ['percentage', 'flat'],
        message: 'Discount type must be "percentage" or "flat"'
      }
    },
    discountValue: {
      type: Number,
      required: [true, 'Discount value is required'],
      min: [0, 'Discount value cannot be negative'],
      validate: {
        validator: function (value) {
          return this.discountType !== 'percentage' || value <= 100;
        },
        message: 'Percentage discount cannot exceed 100'
      }
    },
    minOrderAmount: {
      type: Number,
      min: [0, 'Minimum order amount cannot be negative'],
      default: 0
    },
    // null = no cap on the discount amount
    maxDiscountAmount: {
      type: Number,
      min: [0, 'Maximum discount amount cannot be negative'],
      default: null
    },
    expiryDate: {
      type: Date,
      required: [true, 'Expiry date is required']
    },
    // null = unlimited redemptions
    usageLimit: {
      type: Number,
      min: [1, 'Usage limit must be at least 1'],
      default: null
    },
    usedCount: {
      type: Number,
      min: 0,
      default: 0
    },
    usedBy: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    isActive: {
      type: Boolean,
      default: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  { timestamps: true }
);

couponSchema.index({ isActive: 1, expiryDate: 1 });

/**
 * Discount amount for a given cart subtotal.
 * - percentage: subtotal * value / 100, capped by maxDiscountAmount (if set)
 * - flat: fixed value
 * The discount can never exceed the subtotal.
 */
couponSchema.methods.calculateDiscount = function (subtotal) {
  let discount;
  if (this.discountType === 'percentage') {
    discount = (subtotal * this.discountValue) / 100;
    if (this.maxDiscountAmount !== null && this.maxDiscountAmount !== undefined) {
      discount = Math.min(discount, this.maxDiscountAmount);
    }
  } else {
    discount = this.discountValue;
  }
  return round2(Math.min(Math.max(discount, 0), subtotal));
};

/**
 * Validates this coupon for a user and cart subtotal.
 * Returns { valid, message, discountAmount }. Shared by POST /api/coupons/validate and checkout.
 */
couponSchema.methods.checkEligibility = function (userId, subtotal) {
  const fail = (message) => ({ valid: false, message, discountAmount: 0 });

  if (!this.isActive) return fail('This coupon is not active');
  if (this.expiryDate <= new Date()) return fail('This coupon has expired');

  const hasLimit = this.usageLimit !== null && this.usageLimit !== undefined;
  if (hasLimit && this.usedCount >= this.usageLimit) {
    return fail('This coupon has reached its usage limit');
  }

  if (this.usedBy.some((id) => String(id) === String(userId))) {
    return fail('You have already used this coupon');
  }

  if (subtotal < this.minOrderAmount) {
    return fail(`A minimum order amount of ${this.minOrderAmount} is required for this coupon`);
  }

  return {
    valid: true,
    message: 'Coupon applied successfully',
    discountAmount: this.calculateDiscount(subtotal)
  };
};

/**
 * Atomically redeems the coupon for a user. The filter re-checks every rule, so two
 * simultaneous checkouts cannot exceed usageLimit or use the coupon twice.
 * Returns the updated coupon, or null if it could not be claimed.
 */
couponSchema.statics.claim = function (couponId, userId) {
  return this.findOneAndUpdate(
    {
      _id: couponId,
      isActive: true,
      expiryDate: { $gt: new Date() },
      usedBy: { $ne: userId },
      $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }]
    },
    { $inc: { usedCount: 1 }, $addToSet: { usedBy: userId } },
    { new: true }
  );
};

/**
 * Reverses a claim (checkout rollback, or order cancellation).
 */
couponSchema.statics.release = function (couponId, userId) {
  return this.findOneAndUpdate(
    { _id: couponId, usedBy: userId, usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 }, $pull: { usedBy: userId } },
    { new: true }
  );
};

couponSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Coupon', couponSchema);