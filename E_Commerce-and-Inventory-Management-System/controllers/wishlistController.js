const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

const MAX_RECOMMENDATIONS = 20;
const DEFAULT_RECOMMENDATIONS = 8;

/**
 * GET /api/wishlist  (customer)
 */
const getWishlist = asyncHandler(async (req, res) => {
  const wishlist = await Wishlist.findOne({ user: req.user._id }).populate({
    path: 'products.product',
    match: { isActive: true },
    select: 'name sku category price stock averageRating numReviews imageUrl'
  });

  // Products that were deactivated or deleted are populated as null, so they are skipped
  const items = wishlist
    ? wishlist.products
        .filter((item) => item.product)
        .map((item) => ({ product: item.product, addedAt: item.addedAt }))
    : [];

  res.status(200).json({ success: true, count: items.length, data: { items } });
});

/**
 * POST /api/wishlist/:productId  (customer)
 * Idempotent add: 201 when added, 200 if the product was already in the wishlist.
 */
const addToWishlist = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const userId = req.user._id;

  const product = await Product.findOne({ _id: productId, isActive: true }).select('_id');
  if (!product) {
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }

  // Make sure the user's wishlist document exists (the unique index covers a creation race)
  try {
    await Wishlist.updateOne({ user: userId }, { $setOnInsert: { products: [] } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  // The $ne filter makes the push atomic and prevents duplicates
  const updated = await Wishlist.findOneAndUpdate(
    { user: userId, 'products.product': { $ne: product._id } },
    { $push: { products: { product: product._id, addedAt: new Date() } } },
    { new: true }
  );

  if (!updated) {
    const current = await Wishlist.findOne({ user: userId });
    return res.status(200).json({
      success: true,
      message: 'Product is already in your wishlist',
      data: { count: current ? current.products.length : 0 }
    });
  }

  return res.status(201).json({
    success: true,
    message: 'Product added to wishlist',
    data: { count: updated.products.length }
  });
});

/**
 * DELETE /api/wishlist/:productId  (customer)
 */
const removeFromWishlist = asyncHandler(async (req, res) => {
  const updated = await Wishlist.findOneAndUpdate(
    { user: req.user._id, 'products.product': req.params.productId },
    { $pull: { products: { product: req.params.productId } } },
    { new: true }
  );

  if (!updated) {
    throw new AppError('Product is not in your wishlist', 404, 'NOT_IN_WISHLIST');
  }

  res.status(200).json({
    success: true,
    message: 'Product removed from wishlist',
    data: { count: updated.products.length }
  });
});

/**
 * GET /api/recommendations  (authenticated)   Query: limit (default 8, max 20)
 *
 * 1. Aggregate the categories of the user's past (non-cancelled) orders and of their wishlist.
 * 2. Recommend the highest-rated, in-stock products from those categories,
 *    excluding anything the user already purchased.
 * 3. If there is no history, or too few matches, fill with top-rated products overall.
 */
const getRecommendations = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_RECOMMENDATIONS, 1), MAX_RECOMMENDATIONS);

  const [purchasedCategoryRows, purchasedProductRows, wishlistCategoryRows] = await Promise.all([
    Order.aggregate([
      { $match: { user: userId, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.category', units: { $sum: '$items.quantity' } } }
    ]),
    Order.aggregate([
      { $match: { user: userId, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      { $group: { _id: null, productIds: { $addToSet: '$items.product' } } }
    ]),
    Wishlist.aggregate([
      { $match: { user: userId } },
      { $unwind: '$products' },
      {
        $lookup: {
          from: Product.collection.name,
          localField: 'products.product',
          foreignField: '_id',
          as: 'product'
        }
      },
      { $unwind: '$product' },
      { $group: { _id: '$product.category', count: { $sum: 1 } } }
    ])
  ]);

  const purchasedProductIds = purchasedProductRows.length ? purchasedProductRows[0].productIds : [];

  // category -> where the preference came from
  const preference = new Map();
  purchasedCategoryRows.forEach((row) => preference.set(row._id, { purchased: true, wishlisted: false }));
  wishlistCategoryRows.forEach((row) => {
    const entry = preference.get(row._id) || { purchased: false, wishlisted: false };
    entry.wishlisted = true;
    preference.set(row._id, entry);
  });

  const preferredCategories = [...preference.keys()];
  const describeReason = (category) => {
    const source = preference.get(category);
    if (!source) return 'Top rated product you might like';
    if (source.purchased && source.wishlisted) return `Because you bought from and wishlisted ${category}`;
    return source.purchased ? `Because you bought from ${category}` : `Because you wishlisted ${category}`;
  };

  const baseMatch = { isActive: true, stock: { $gt: 0 }, _id: { $nin: purchasedProductIds } };
  const ranking = [{ $sort: { averageRating: -1, numReviews: -1, createdAt: -1 } }, { $project: { __v: 0 } }];

  let personalised = [];
  if (preferredCategories.length > 0) {
    personalised = await Product.aggregate([
      { $match: { ...baseMatch, category: { $in: preferredCategories } } },
      ...ranking,
      { $limit: limit }
    ]);
    personalised = personalised.map((p) => ({ ...p, reason: describeReason(p.category) }));
  }

  // Top up (or fully fall back for new users) with the highest-rated products overall
  let fallback = [];
  if (personalised.length < limit) {
    const excludeIds = [...purchasedProductIds, ...personalised.map((p) => p._id)];
    fallback = await Product.aggregate([
      { $match: { isActive: true, stock: { $gt: 0 }, _id: { $nin: excludeIds } } },
      ...ranking,
      { $limit: limit - personalised.length }
    ]);
    fallback = fallback.map((p) => ({ ...p, reason: 'Top rated and trending right now' }));
  }

  res.status(200).json({
    success: true,
    data: {
      strategy: preferredCategories.length > 0 ? 'personalized' : 'fallback',
      preferredCategories,
      count: personalised.length + fallback.length,
      recommendations: [...personalised, ...fallback]
    }
  });
});

module.exports = { getWishlist, addToWishlist, removeFromWishlist, getRecommendations };