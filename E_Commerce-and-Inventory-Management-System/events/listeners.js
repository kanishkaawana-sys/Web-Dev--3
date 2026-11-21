const { eventBus, EVENTS } = require('./eventBus');
const AuditLog = require('../models/AuditLog');
const Product = require('../models/Product');
const Review = require('../models/Review');
const { emitToAdmins, emitToUser, SOCKET_EVENTS } = require('../sockets/socketHandler');

/*
 * Event payload contracts (emitted by controllers in Phase 3):
 *
 * order:placed        { orderId, userId, customerName, totalAmount, discountAmount, couponCode,
 *                       status, createdAt, items: [{ productId, name, sku, quantity }] }
 * order:statusUpdated { orderId, userId, previousStatus, newStatus, changedBy, note,
 *                       restockedProductIds? }
 * inventory:lowStock  { productId, name, sku, stock, lowStockThreshold }
 * review:updated      { productId, reviewId, userId, action: 'created'|'updated'|'deleted', rating }
 * coupon:redeemed     { couponId, code, userId, orderId, discountAmount }
 */

// A failing listener must never crash the server or affect the HTTP response
const safe = (eventName, handler) => async (payload) => {
  try {
    await handler(payload);
  } catch (err) {
    console.error(`[EVENT] Listener for "${eventName}" failed: ${err.message}`);
  }
};

// Reads fresh stock from MongoDB and broadcasts stock:updated to the admin room
const broadcastStockUpdates = async (productIds, reason, orderId) => {
  const ids = [...new Set((productIds || []).map(String))];
  if (ids.length === 0) return [];

  const products = await Product.find({ _id: { $in: ids } })
    .select('name sku stock lowStockThreshold')
    .lean();

  products.forEach((p) => {
    emitToAdmins(SOCKET_EVENTS.STOCK_UPDATED, {
      productId: String(p._id),
      name: p.name,
      sku: p.sku,
      stock: p.stock,
      lowStockThreshold: p.lowStockThreshold,
      reason,
      orderId: orderId ? String(orderId) : undefined,
      timestamp: new Date().toISOString()
    });
  });

  return products;
};

// order:placed -> audit entry, admin notification, stock broadcast, low-stock threshold check
const onOrderPlaced = async (payload) => {
  const items = payload.items || [];

  await AuditLog.record({
    action: 'ORDER_PLACED',
    entityType: 'Order',
    entityId: payload.orderId,
    actor: payload.userId,
    message: `Order ${payload.orderId} placed by ${payload.customerName || payload.userId} (total ${payload.totalAmount})`,
    metadata: {
      totalAmount: payload.totalAmount,
      discountAmount: payload.discountAmount,
      couponCode: payload.couponCode || null,
      items: items.map((i) => ({ productId: i.productId, sku: i.sku, quantity: i.quantity }))
    }
  });

  emitToAdmins(SOCKET_EVENTS.ORDER_NEW, {
    orderId: String(payload.orderId),
    userId: String(payload.userId),
    customerName: payload.customerName,
    totalAmount: payload.totalAmount,
    discountAmount: payload.discountAmount,
    couponCode: payload.couponCode || null,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    status: payload.status,
    createdAt: payload.createdAt || new Date().toISOString()
  });

  // Broadcast the new stock levels, then check each product against its threshold
  const products = await broadcastStockUpdates(
    items.map((i) => i.productId),
    'order:placed',
    payload.orderId
  );

  products
    .filter((p) => p.stock <= p.lowStockThreshold)
    .forEach((p) => {
      eventBus.emit(EVENTS.INVENTORY_LOW_STOCK, {
        productId: String(p._id),
        name: p.name,
        sku: p.sku,
        stock: p.stock,
        lowStockThreshold: p.lowStockThreshold
      });
    });
};

// order:statusUpdated -> audit entry, real-time update to the customer, stock broadcast on cancel
const onOrderStatusUpdated = async (payload) => {
  await AuditLog.record({
    action: 'ORDER_STATUS_UPDATED',
    entityType: 'Order',
    entityId: payload.orderId,
    actor: payload.changedBy,
    message: `Order ${payload.orderId} status changed: ${payload.previousStatus} -> ${payload.newStatus}`,
    metadata: { previousStatus: payload.previousStatus, newStatus: payload.newStatus, note: payload.note || '' }
  });

  emitToUser(payload.userId, SOCKET_EVENTS.ORDER_STATUS_CHANGED, {
    orderId: String(payload.orderId),
    previousStatus: payload.previousStatus,
    status: payload.newStatus,
    note: payload.note || '',
    updatedAt: new Date().toISOString()
  });

  if (payload.restockedProductIds && payload.restockedProductIds.length > 0) {
    await broadcastStockUpdates(payload.restockedProductIds, 'order:cancelled', payload.orderId);
  }
};

// inventory:lowStock -> warning audit entry and alert to admins/managers
const onLowStock = async (payload) => {
  const message = `Low stock: "${payload.name}" (${payload.sku}) has ${payload.stock} unit(s) left (threshold ${payload.lowStockThreshold})`;

  await AuditLog.record({
    action: 'LOW_STOCK_ALERT',
    entityType: 'Product',
    entityId: payload.productId,
    level: 'warning',
    message,
    metadata: { stock: payload.stock, lowStockThreshold: payload.lowStockThreshold }
  });

  emitToAdmins(SOCKET_EVENTS.ALERT_LOW_STOCK, {
    productId: String(payload.productId),
    name: payload.name,
    sku: payload.sku,
    stock: payload.stock,
    lowStockThreshold: payload.lowStockThreshold,
    message,
    timestamp: new Date().toISOString()
  });
};

// review:updated -> recompute averageRating and numReviews on the Product, then audit
const onReviewUpdated = async (payload) => {
  const { averageRating, numReviews } = await Review.calcAverageRating(payload.productId);

  await AuditLog.record({
    action: 'REVIEW_UPDATED',
    entityType: 'Review',
    entityId: payload.reviewId,
    actor: payload.userId,
    message: `Review ${payload.action} on product ${payload.productId}. New average ${averageRating} from ${numReviews} review(s)`,
    metadata: { productId: String(payload.productId), action: payload.action, rating: payload.rating, averageRating, numReviews }
  });
};

// coupon:redeemed -> redemption audit entry
const onCouponRedeemed = async (payload) => {
  await AuditLog.record({
    action: 'COUPON_REDEEMED',
    entityType: 'Coupon',
    entityId: payload.couponId,
    actor: payload.userId,
    message: `Coupon ${payload.code} redeemed on order ${payload.orderId} (discount ${payload.discountAmount})`,
    metadata: { code: payload.code, orderId: String(payload.orderId), discountAmount: payload.discountAmount }
  });
};

let registered = false;

/**
 * Subscribes all domain listeners to the event bus. Call once at startup (server.js).
 */
const registerListeners = () => {
  if (registered) return;
  registered = true;

  eventBus.on(EVENTS.ORDER_PLACED, safe(EVENTS.ORDER_PLACED, onOrderPlaced));
  eventBus.on(EVENTS.ORDER_STATUS_UPDATED, safe(EVENTS.ORDER_STATUS_UPDATED, onOrderStatusUpdated));
  eventBus.on(EVENTS.INVENTORY_LOW_STOCK, safe(EVENTS.INVENTORY_LOW_STOCK, onLowStock));
  eventBus.on(EVENTS.REVIEW_UPDATED, safe(EVENTS.REVIEW_UPDATED, onReviewUpdated));
  eventBus.on(EVENTS.COUPON_REDEEMED, safe(EVENTS.COUPON_REDEEMED, onCouponRedeemed));

  console.log('[EVENTS] Domain event listeners registered');
};

module.exports = { registerListeners };