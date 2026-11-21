const Review = require('../models/Review');
const Product = require('../models/Product');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { eventBus, EVENTS } = require('../events/eventBus');

const REVIEW_SORTS = {
  newest: { createdAt: -1, _id: 1 },
  highest: { rating: -1, createdAt: -1 },
  lowest: { rating: 1, createdAt: -1 }
};

const parsePagination = (query, defaultLimit = 10, maxLimit = 50) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

const emitReviewUpdated = (review, action) => {
  eventBus.emit(EVENTS.REVIEW_UPDATED, {
    productId: String(review.product),
    reviewId: String(review._id),
    userId: String(review.user),
    action,
    rating: review.rating
  });
};

/**
 * GET /api/products/:productId/reviews  (public)
 * Query: sort (newest|highest|lowest), page, limit
 */
const getProductReviews = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.productId).select('name averageRating numReviews');
  if (!product) {
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }

  const { page, limit, skip } = parsePagination(req.query);
  const sortOrder = REVIEW_SORTS[req.query.sort] || REVIEW_SORTS.newest;

  const [reviews, total] = await Promise.all([
    Review.find({ product: product._id }).populate('user', 'name').sort(sortOrder).skip(skip).limit(limit),
    Review.countDocuments({ product: product._id })
  ]);

  res.status(200).json({
    success: true,
    count: reviews.length,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    summary: { averageRating: product.averageRating, numReviews: product.numReviews },
    data: reviews
  });
});

/**
 * POST /api/products/:productId/reviews  (customer)
 * Body: { rating, title, comment? }
 */
const createReview = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.productId, isActive: true }).select('_id');
  if (!product) {
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }

  const existing = await Review.exists({ product: product._id, user: req.user._id });
  if (existing) {
    throw new AppError('You have already reviewed this product. Update your existing review instead.', 409, 'REVIEW_EXISTS');
  }

  const { rating, title, comment } = req.body || {};
  const isVerifiedPurchase = await Review.checkVerifiedPurchase(req.user._id, product._id);

  const review = await Review.create({
    product: product._id,
    user: req.user._id,
    rating,
    title,
    comment,
    isVerifiedPurchase
  });

  // The review:updated listener recalculates averageRating and numReviews
  emitReviewUpdated(review, 'created');

  res.status(201).json({ success: true, message: 'Review added', data: review });
});

/**
 * PUT /api/reviews/:reviewId  (review owner)
 * Body: any of { rating, title, comment }
 */
const updateReview = asyncHandler(async (req, res) => {
  const review = await Review.findById(req.params.reviewId);
  if (!review) {
    throw new AppError('Review not found', 404, 'REVIEW_NOT_FOUND');
  }
  if (String(review.user) !== String(req.user._id)) {
    throw new AppError('You can only edit your own reviews', 403, 'FORBIDDEN');
  }

  const { rating, title, comment } = req.body || {};
  if (rating === undefined && title === undefined && comment === undefined) {
    throw new AppError('Provide at least one of rating, title or comment', 400, 'VALIDATION_ERROR');
  }

  if (rating !== undefined) review.rating = rating;
  if (title !== undefined) review.title = title;
  if (comment !== undefined) review.comment = comment;
  await review.save();

  emitReviewUpdated(review, 'updated');

  res.status(200).json({ success: true, message: 'Review updated', data: review });
});

/**
 * DELETE /api/reviews/:reviewId  (review owner or admin)
 */
const deleteReview = asyncHandler(async (req, res) => {
  const review = await Review.findById(req.params.reviewId);
  if (!review) {
    throw new AppError('Review not found', 404, 'REVIEW_NOT_FOUND');
  }

  const isOwner = String(review.user) === String(req.user._id);
  if (!isOwner && req.user.role !== 'admin') {
    throw new AppError('You can only delete your own reviews', 403, 'FORBIDDEN');
  }

  await review.deleteOne();
  emitReviewUpdated(review, 'deleted');

  res.status(200).json({ success: true, message: 'Review deleted' });
});

module.exports = { getProductReviews, createReview, updateReview, deleteReview };