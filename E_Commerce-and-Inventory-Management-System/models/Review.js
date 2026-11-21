const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product is required']
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required']
    },
    rating: {
      type: Number,
      required: [true, 'Rating is required'],
      min: [1, 'Rating must be at least 1'],
      max: [5, 'Rating cannot exceed 5'],
      validate: { validator: Number.isInteger, message: 'Rating must be a whole number' }
    },
    title: {
      type: String,
      required: [true, 'Review title is required'],
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters']
    },
    comment: {
      type: String,
      trim: true,
      maxlength: [1000, 'Comment cannot exceed 1000 characters'],
      default: ''
    },
    isVerifiedPurchase: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

// One review per customer per product
reviewSchema.index({ product: 1, user: 1 }, { unique: true });
reviewSchema.index({ product: 1, createdAt: -1 });

/**
 * Recomputes averageRating (1 decimal) and numReviews for a product using an aggregation
 * pipeline and writes them to the Product document. Called by the review:updated listener.
 */
reviewSchema.statics.calcAverageRating = async function (productId) {
  const Product = mongoose.model('Product');

  const [stats] = await this.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(productId)) } },
    {
      $group: {
        _id: '$product',
        averageRating: { $avg: '$rating' },
        numReviews: { $sum: 1 }
      }
    }
  ]);

  const averageRating = stats ? Math.round(stats.averageRating * 10) / 10 : 0;
  const numReviews = stats ? stats.numReviews : 0;

  await Product.findByIdAndUpdate(productId, { averageRating, numReviews });
  return { averageRating, numReviews };
};

/**
 * A review is a "verified purchase" if the user has a non-cancelled (placed or delivered)
 * order containing the product.
 */
reviewSchema.statics.checkVerifiedPurchase = async function (userId, productId) {
  const Order = mongoose.model('Order');
  const found = await Order.exists({
    user: userId,
    'items.product': productId,
    status: { $ne: 'cancelled' }
  });
  return Boolean(found);
};

reviewSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Review', reviewSchema);