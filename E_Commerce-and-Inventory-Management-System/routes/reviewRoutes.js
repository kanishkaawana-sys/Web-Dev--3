const express = require('express');
const {
  getProductReviews,
  createReview,
  updateReview,
  deleteReview
} = require('../controllers/reviewController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');

const router = express.Router();

// Reviews of a product
router.get('/products/:productId/reviews', getProductReviews);
router.post('/products/:productId/reviews', protect, authorize('customer'), createReview);

// A single review (ownership is enforced in the controller)
router.put('/reviews/:reviewId', protect, authorize('customer'), updateReview);
router.delete('/reviews/:reviewId', protect, authorize('customer', 'admin'), deleteReview);

module.exports = router;