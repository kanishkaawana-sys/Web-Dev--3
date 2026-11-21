const mongoose = require('mongoose');

const AUDIT_ACTIONS = [
  'ORDER_PLACED',
  'ORDER_STATUS_UPDATED',
  'LOW_STOCK_ALERT',
  'COUPON_REDEEMED',
  'REVIEW_UPDATED'
];

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: [true, 'Audit action is required'],
      enum: AUDIT_ACTIONS
    },
    entityType: {
      type: String,
      enum: ['Order', 'Product', 'Coupon', 'Review', 'User']
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    level: {
      type: String,
      enum: ['info', 'warning'],
      default: 'info'
    },
    message: {
      type: String,
      required: [true, 'Audit message is required']
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed
    }
  },
  // Audit entries are immutable, so only createdAt is tracked
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });

/**
 * Writes an audit entry. A failure here is logged but never thrown,
 * so auditing can never break a business flow.
 */
auditLogSchema.statics.record = async function (entry) {
  try {
    return await this.create(entry);
  } catch (err) {
    console.error(`[AUDIT] Failed to write audit log (${entry && entry.action}): ${err.message}`);
    return null;
  }
};

auditLogSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('AuditLog', auditLogSchema);