const Order = require('../models/Order');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { eventBus, EVENTS } = require('../events/eventBus');

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const MAX_LINE_ITEMS = 50;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const isStaff = (user) => user.role === 'admin' || user.role === 'manager';

const parsePagination = (query, defaultLimit = 10, maxLimit = 100) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

// Adds quantities back to product stock (checkout rollback and order cancellation)
const restoreStock = (items) =>
  Product.bulkWrite(
    items.map((item) => ({
      updateOne: { filter: { _id: item.product }, update: { $inc: { stock: item.quantity } } }
    }))
  );

// Validates the checkout items array and merges duplicate products into one line
const normaliseCartItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('items must be a non-empty array of { productId, quantity }', 400, 'VALIDATION_ERROR');
  }
  if (items.length > MAX_LINE_ITEMS) {
    throw new AppError(`An order can contain at most ${MAX_LINE_ITEMS} line items`, 400, 'VALIDATION_ERROR');
  }

  const merged = new Map();
  items.forEach((item) => {
    const quantity = Number(item && item.quantity);
    if (!item || !OBJECT_ID_REGEX.test(String(item.productId))) {
      throw new AppError('Each item needs a valid productId', 400, 'VALIDATION_ERROR');
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new AppError('Each item quantity must be a whole number >= 1', 400, 'VALIDATION_ERROR');
    }
    const key = String(item.productId);
    merged.set(key, (merged.get(key) || 0) + quantity);
  });

  return merged;
};

/**
 * POST /api/orders  (authenticated)  -- checkout
 * Body: { items: [{ productId, quantity }], shippingAddress: {...}, paymentMethod?, couponCode? }
 *
 * Flow: validate -> price from DB -> coupon check -> ATOMIC stock decrement per line ->
 * atomic coupon claim -> save order -> emit events. Any failure after the first decrement
 * rolls back the stock and the coupon claim.
 */
const createOrder = asyncHandler(async (req, res) => {
  const { items, shippingAddress, paymentMethod, couponCode } = req.body || {};
  const userId = req.user._id;

  // 1. Validate the cart and load live product data
  const cart = normaliseCartItems(items);
  const products = await Product.find({ _id: { $in: [...cart.keys()] }, isActive: true });
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const missing = [...cart.keys()].filter((id) => !productMap.has(id));
  if (missing.length > 0) {
    throw new AppError('One or more products were not found or are unavailable', 404, 'PRODUCT_NOT_FOUND', { missing });
  }

  // 2. Fast stock pre-check for a clear message (the atomic update below is the real guard)
  const shortages = [];
  cart.forEach((quantity, id) => {
    const product = productMap.get(id);
    if (product.stock < quantity) {
      shortages.push({ productId: id, name: product.name, requested: quantity, available: product.stock });
    }
  });
  if (shortages.length > 0) {
    throw new AppError('Insufficient stock for one or more items', 409, 'INSUFFICIENT_STOCK', shortages);
  }

  // 3. Price snapshots and subtotal
  const orderItems = [...cart.entries()].map(([id, quantity]) => {
    const product = productMap.get(id);
    return {
      product: product._id,
      name: product.name,
      sku: product.sku,
      category: product.category,
      price: product.price,
      quantity
    };
  });
  const subtotal = round2(orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0));

  // 4. Coupon eligibility (the atomic claim happens after stock is secured)
  let coupon = null;
  let discountAmount = 0;
  if (couponCode !== undefined && couponCode !== null && String(couponCode).trim() !== '') {
    if (typeof couponCode !== 'string') {
      throw new AppError('couponCode must be a string', 400, 'VALIDATION_ERROR');
    }
    coupon = await Coupon.findOne({ code: couponCode.trim().toUpperCase() });
    if (!coupon) {
      throw new AppError('Invalid coupon code', 400, 'COUPON_INVALID');
    }
    const eligibility = coupon.checkEligibility(userId, subtotal);
    if (!eligibility.valid) {
      throw new AppError(eligibility.message, 400, 'COUPON_INVALID');
    }
    discountAmount = eligibility.discountAmount;
  }

  // 5. Build and validate the order BEFORE touching stock, so bad input fails cleanly
  const order = new Order({
    user: userId,
    items: orderItems,
    shippingAddress,
    paymentMethod,
    coupon: coupon ? coupon._id : undefined,
    couponCode: coupon ? coupon.code : undefined,
    discountAmount
  });
  await order.validate();

  // 6. ATOMIC stock decrement. The filter { stock: { $gte: qty } } and $inc are one atomic
  //    operation, so two simultaneous buyers can never push stock below zero.
  const decremented = [];
  try {
    for (const item of orderItems) {
      const updated = await Product.findOneAndUpdate(
        { _id: item.product, isActive: true, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity } },
        { new: true }
      );

      if (!updated) {
        throw new AppError(`Insufficient stock for "${item.name}"`, 409, 'INSUFFICIENT_STOCK', [
          { productId: String(item.product), name: item.name, requested: item.quantity }
        ]);
      }
      decremented.push({ product: item.product, quantity: item.quantity });
    }
  } catch (err) {
    if (decremented.length > 0) {
      await restoreStock(decremented).catch((e) => console.error(`[ORDER] Stock rollback failed: ${e.message}`));
    }
    throw err;
  }

  // 7. Atomically claim the coupon, then persist the order. Roll everything back on failure.
  let couponClaimed = false;
  try {
    if (coupon) {
      const claimed = await Coupon.claim(coupon._id, userId);
      if (!claimed) {
        throw new AppError('Coupon could not be applied (usage limit reached or already used)', 409, 'COUPON_UNAVAILABLE');
      }
      couponClaimed = true;
    }
    await order.save();
  } catch (err) {
    await restoreStock(decremented).catch((e) => console.error(`[ORDER] Stock rollback failed: ${e.message}`));
    if (couponClaimed) {
      await Coupon.release(coupon._id, userId).catch((e) => console.error(`[ORDER] Coupon rollback failed: ${e.message}`));
    }
    throw err;
  }

  // 8. Decoupled side effects (audit, notifications, low-stock checks) via EventEmitter
  eventBus.emit(EVENTS.ORDER_PLACED, {
    orderId: String(order._id),
    userId: String(userId),
    customerName: req.user.name,
    totalAmount: order.totalAmount,
    discountAmount: order.discountAmount,
    couponCode: order.couponCode || null,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    items: order.items.map((i) => ({
      productId: String(i.product),
      name: i.name,
      sku: i.sku,
      quantity: i.quantity
    }))
  });

  if (coupon) {
    eventBus.emit(EVENTS.COUPON_REDEEMED, {
      couponId: String(coupon._id),
      code: coupon.code,
      userId: String(userId),
      orderId: String(order._id),
      discountAmount: order.discountAmount
    });
  }

  res.status(201).json({ success: true, message: 'Order placed successfully', data: order });
});

// Atomic status transition: only succeeds if the order is still in the status we read
const transitionOrder = async (order, newStatus, actorId, note, extraSet = {}) => {
  const entry = { status: newStatus, changedBy: actorId, changedAt: new Date(), note: note || '' };

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: order.status },
    { $set: { status: newStatus, ...extraSet }, $push: { statusHistory: entry } },
    { new: true }
  );

  if (!updated) {
    throw new AppError(
      'The order status was changed by another request. Please reload and try again.',
      409,
      'STATUS_CONFLICT'
    );
  }
  return updated;
};

// Cancels an order: atomic status change, then restore stock and release the coupon
const performCancellation = async (order, actorId, note) => {
  // The atomic transition is the gate: only one request can ever move the order to "cancelled"
  const cancelled = await transitionOrder(order, 'cancelled', actorId, note, { cancelledAt: new Date() });

  let restockedProductIds = [];
  if (!cancelled.stockRestored) {
    await restoreStock(cancelled.items);
    await Order.updateOne({ _id: cancelled._id }, { $set: { stockRestored: true } });
    restockedProductIds = cancelled.items.map((i) => String(i.product));
  }

  if (cancelled.coupon) {
    await Coupon.release(cancelled.coupon, cancelled.user);
  }

  return { order: await Order.findById(cancelled._id), restockedProductIds };
};

const emitStatusUpdated = (previousStatus, order, actorId, note, restockedProductIds = []) => {
  eventBus.emit(EVENTS.ORDER_STATUS_UPDATED, {
    orderId: String(order._id),
    userId: String(order.user),
    previousStatus,
    newStatus: order.status,
    changedBy: String(actorId),
    note: note || '',
    restockedProductIds
  });
};

/**
 * GET /api/orders/my  (authenticated)
 */
const getMyOrders = asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  if (typeof req.query.status === 'string' && Order.STATUSES.includes(req.query.status)) {
    filter.status = req.query.status;
  }

  const { page, limit, skip } = parsePagination(req.query);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter)
  ]);

  res.status(200).json({
    success: true,
    count: orders.length,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    data: orders
  });
});

/**
 * GET /api/orders  (admin, manager)
 * Query: status, userId, startDate, endDate, page, limit
 */
const getAllOrders = asyncHandler(async (req, res) => {
  const { status, userId, startDate, endDate } = req.query;
  const filter = {};

  if (typeof status === 'string' && Order.STATUSES.includes(status)) filter.status = status;
  if (typeof userId === 'string' && OBJECT_ID_REGEX.test(userId)) filter.user = userId;

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) {
      const from = new Date(startDate);
      if (Number.isNaN(from.getTime())) throw new AppError('startDate is not a valid date', 400, 'VALIDATION_ERROR');
      filter.createdAt.$gte = from;
    }
    if (endDate) {
      const to = new Date(endDate);
      if (Number.isNaN(to.getTime())) throw new AppError('endDate is not a valid date', 400, 'VALIDATION_ERROR');
      filter.createdAt.$lte = to;
    }
  }

  const { page, limit, skip } = parsePagination(req.query);
  const [orders, total] = await Promise.all([
    Order.find(filter).populate('user', 'name email').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter)
  ]);

  res.status(200).json({
    success: true,
    count: orders.length,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    data: orders
  });
});

/**
 * GET /api/orders/:id  (owner, admin, manager)
 */
const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  }

  if (!isStaff(req.user) && String(order.user) !== String(req.user._id)) {
    throw new AppError('You do not have access to this order', 403, 'FORBIDDEN');
  }

  await order.populate('user', 'name email');
  res.status(200).json({ success: true, data: order });
});

/**
 * PATCH /api/orders/:id/status  (admin, manager)
 * Body: { status, note? }.  Lifecycle: pending -> confirmed -> shipped -> delivered, or cancelled.
 */
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body || {};

  if (typeof status !== 'string' || !Order.STATUSES.includes(status)) {
    throw new AppError(`status must be one of: ${Order.STATUSES.join(', ')}`, 400, 'VALIDATION_ERROR');
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  }

  if (!Order.canTransition(order.status, status)) {
    const allowed = Order.nextStatuses(order.status);
    throw new AppError(
      `Cannot change order status from "${order.status}" to "${status}". ` +
        (allowed.length ? `Allowed next statuses: ${allowed.join(', ')}` : 'This order is in a final state.'),
      400,
      'INVALID_STATUS_TRANSITION'
    );
  }

  const previousStatus = order.status;
  let updatedOrder;
  let restockedProductIds = [];

  if (status === 'cancelled') {
    ({ order: updatedOrder, restockedProductIds } = await performCancellation(order, req.user._id, note));
  } else {
    const extraSet = status === 'delivered' ? { deliveredAt: new Date() } : {};
    updatedOrder = await transitionOrder(order, status, req.user._id, note, extraSet);
  }

  emitStatusUpdated(previousStatus, updatedOrder, req.user._id, note, restockedProductIds);

  res.status(200).json({ success: true, message: `Order status updated to "${status}"`, data: updatedOrder });
});

/**
 * PATCH /api/orders/:id/cancel  (owner, admin, manager)
 * Body: { note? }.  Only pending or confirmed orders can be cancelled.
 */
const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  }

  if (!isStaff(req.user) && String(order.user) !== String(req.user._id)) {
    throw new AppError('You do not have access to this order', 403, 'FORBIDDEN');
  }

  if (!Order.canTransition(order.status, 'cancelled')) {
    throw new AppError(`An order with status "${order.status}" cannot be cancelled`, 400, 'INVALID_STATUS_TRANSITION');
  }

  const note = (req.body && req.body.note) || (isStaff(req.user) ? 'Cancelled by staff' : 'Cancelled by customer');
  const previousStatus = order.status;
  const { order: cancelledOrder, restockedProductIds } = await performCancellation(order, req.user._id, note);

  emitStatusUpdated(previousStatus, cancelledOrder, req.user._id, note, restockedProductIds);

  res.status(200).json({ success: true, message: 'Order cancelled and stock restored', data: cancelledOrder });
});

module.exports = {
  createOrder,
  getMyOrders,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder
};