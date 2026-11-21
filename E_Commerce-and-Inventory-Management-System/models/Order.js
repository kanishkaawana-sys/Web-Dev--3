const mongoose = require('mongoose');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

// Allowed lifecycle transitions
const STATUS_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: []
};

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Snapshots so history and analytics survive later product edits or deletion
    name: { type: String, required: true },
    sku: { type: String, required: true },
    category: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1'],
      validate: { validator: Number.isInteger, message: 'Quantity must be a whole number' }
    },
    lineTotal: { type: Number, min: 0 }
  },
  { _id: false }
);

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: [true, 'Full name is required'], trim: true },
    phone: { type: String, required: [true, 'Phone is required'], trim: true },
    line1: { type: String, required: [true, 'Address line 1 is required'], trim: true },
    line2: { type: String, trim: true, default: '' },
    city: { type: String, required: [true, 'City is required'], trim: true },
    state: { type: String, required: [true, 'State is required'], trim: true },
    postalCode: { type: String, required: [true, 'Postal code is required'], trim: true },
    country: { type: String, trim: true, default: 'India' }
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: {
      type: [orderItemSchema],
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: 'An order must contain at least one item'
      }
    },
    shippingAddress: { type: shippingAddressSchema, required: true },
    // Recorded only; there is no payment gateway in this project
    paymentMethod: {
      type: String,
      enum: { values: ['cod', 'card', 'upi'], message: 'Payment method must be cod, card or upi' },
      default: 'cod'
    },
    subtotal: { type: Number, min: 0 },
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
    couponCode: { type: String, uppercase: true, trim: true },
    discountAmount: { type: Number, min: 0, default: 0 },
    totalAmount: { type: Number, min: 0 },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending' },
    statusHistory: { type: [statusHistorySchema], default: [] },
    // Guards against restoring stock twice if cancel is called repeatedly
    stockRestored: { type: Boolean, default: false },
    deliveredAt: { type: Date },
    cancelledAt: { type: Date }
  },
  { timestamps: true }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'items.product': 1 });

// For new orders the model computes all money fields, so they are always consistent
orderSchema.pre('validate', function () {
  if (!this.isNew) return;

  this.items.forEach((item) => {
    item.lineTotal = round2(item.price * item.quantity);
  });
  this.subtotal = round2(this.items.reduce((sum, item) => sum + item.lineTotal, 0));
  this.discountAmount = round2(Math.min(this.discountAmount || 0, this.subtotal));
  this.totalAmount = round2(this.subtotal - this.discountAmount);

  if (this.statusHistory.length === 0) {
    this.statusHistory.push({ status: this.status, changedBy: this.user, note: 'Order placed' });
  }
});

// Lifecycle helpers used by orderController
orderSchema.statics.STATUSES = ORDER_STATUSES;

orderSchema.statics.nextStatuses = function (currentStatus) {
  return STATUS_TRANSITIONS[currentStatus] || [];
};

orderSchema.statics.canTransition = function (fromStatus, toStatus) {
  return (STATUS_TRANSITIONS[fromStatus] || []).includes(toStatus);
};

orderSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Order', orderSchema);