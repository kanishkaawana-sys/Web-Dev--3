const Coupon = require('../models/Coupon');
const Product = require('../models/Product');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

const CREATE_FIELDS = [
  'code',
  'description',
  'discountType',
  'discountValue',
  'minOrderAmount',
  'maxDiscountAmount',
  'expiryDate',
  'usageLimit',
  'isActive'
];
// The code, usedCount and usedBy cannot be edited after creation
const UPDATE_FIELDS = CREATE_FIELDS.filter((f) => f !== 'code');

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const pickFields = (source, fields) => {
  const picked = {};
  fields.forEach((field) => {
    if (source && source[field] !== undefined) picked[field] = source[field];
  });
  return picked;
};

const parsePagination = (query, defaultLimit = 20, maxLimit = 100) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

// Cart subtotal from live database prices, so clients cannot lie about the amount
const computeSubtotalFromItems = async (items) => {
  const quantities = new Map();

  for (const item of items) {
    const quantity = Number(item && item.quantity);
    if (!item || !OBJECT_ID_REGEX.test(String(item.productId)) || !Number.isInteger(quantity) || quantity < 1) {
      throw new AppError('Each item needs a valid productId and a whole-number quantity >= 1', 400, 'VALIDATION_ERROR');
    }
    const key = String(item.productId);
    quantities.set(key, (quantities.get(key) || 0) + quantity);
  }

  const products = await Product.find({ _id: { $in: [...quantities.keys()] }, isActive: true }).select('price');
  if (products.length !== quantities.size) {
    throw new AppError('One or more products in the cart were not found', 404, 'PRODUCT_NOT_FOUND');
  }

  return round2(products.reduce((sum, p) => sum + p.price * quantities.get(String(p._id)), 0));
};

/**
 * POST /api/coupons/validate  (authenticated)
 * Body: { code, items: [{ productId, quantity }] }  or  { code, subtotal }
 * Rule failures return 200 with valid:false and the reason.
 */
const validateCoupon = asyncHandler(async (req, res) => {
  const { code, items, subtotal } = req.body || {};

  if (typeof code !== 'string' || !code.trim()) {
    throw new AppError('Coupon code is required', 400, 'VALIDATION_ERROR');
  }

  let cartSubtotal;
  if (Array.isArray(items) && items.length > 0) {
    cartSubtotal = await computeSubtotalFromItems(items);
  } else if (subtotal !== undefined && Number(subtotal) > 0) {
    cartSubtotal = round2(Number(subtotal));
  } else {
    throw new AppError('Provide either a non-empty items array or a positive subtotal', 400, 'VALIDATION_ERROR');
  }

  const coupon = await Coupon.findOne({ code: code.trim().toUpperCase() });
  if (!coupon) {
    return res.status(200).json({
      success: true,
      data: { valid: false, message: 'Invalid coupon code', code: code.trim().toUpperCase(), subtotal: cartSubtotal }
    });
  }

  const result = coupon.checkEligibility(req.user._id, cartSubtotal);

  res.status(200).json({
    success: true,
    data: {
      valid: result.valid,
      message: result.message,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      subtotal: cartSubtotal,
      discountAmount: result.discountAmount,
      finalAmount: round2(cartSubtotal - result.discountAmount)
    }
  });
});

/**
 * GET /api/coupons  (admin)
 * Query: isActive=true|false, page, limit
 */
const getCoupons = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.isActive === 'true') filter.isActive = true;
  if (req.query.isActive === 'false') filter.isActive = false;

  const { page, limit, skip } = parsePagination(req.query);

  const [coupons, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Coupon.countDocuments(filter)
  ]);

  res.status(200).json({
    success: true,
    count: coupons.length,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    data: coupons
  });
});

/**
 * GET /api/coupons/:id  (admin)
 */
const getCouponById = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) {
    throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  }
  res.status(200).json({ success: true, data: coupon });
});

/**
 * POST /api/coupons  (admin)
 */
const createCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.create({
    ...pickFields(req.body, CREATE_FIELDS),
    createdBy: req.user._id
  });
  res.status(201).json({ success: true, message: 'Coupon created', data: coupon });
});

/**
 * PUT /api/coupons/:id  (admin)
 */
const updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) {
    throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  }

  const updates = pickFields(req.body, UPDATE_FIELDS);
  if (Object.keys(updates).length === 0) {
    throw new AppError('No valid fields provided to update', 400, 'VALIDATION_ERROR');
  }

  coupon.set(updates);

  if (coupon.usageLimit !== null && coupon.usageLimit !== undefined && coupon.usageLimit < coupon.usedCount) {
    throw new AppError(
      `usageLimit cannot be lower than the number of redemptions already made (${coupon.usedCount})`,
      400,
      'VALIDATION_ERROR'
    );
  }

  await coupon.save();
  res.status(200).json({ success: true, message: 'Coupon updated', data: coupon });
});

/**
 * DELETE /api/coupons/:id  (admin)
 * Orders keep a couponCode snapshot, so deleting a coupon never breaks order history.
 */
const deleteCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findByIdAndDelete(req.params.id);
  if (!coupon) {
    throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  }
  res.status(200).json({ success: true, message: 'Coupon deleted' });
});

module.exports = {
  validateCoupon,
  getCoupons,
  getCouponById,
  createCoupon,
  updateCoupon,
  deleteCoupon
};