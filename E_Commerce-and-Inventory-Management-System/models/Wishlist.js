const mongoose = require('mongoose');

const wishlistItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const wishlistSchema = new mongoose.Schema(
  {
    // One wishlist document per user
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      unique: true
    },
    products: {
      type: [wishlistItemSchema],
      default: []
    }
  },
  { timestamps: true }
);

wishlistSchema.index({ 'products.product': 1 });

wishlistSchema.methods.hasProduct = function (productId) {
  return this.products.some((item) => String(item.product) === String(productId));
};

wishlistSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Wishlist', wishlistSchema);