const express = require('express');
const {
  createOrder,
  getMyOrders,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder
} = require('../controllers/orderController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');

const router = express.Router();

router.use(protect);

router.post('/', createOrder);

// Must be declared before "/:id"
router.get('/my', getMyOrders);

router.get('/', authorize('admin', 'manager'), getAllOrders);
router.get('/:id', getOrderById);
router.patch('/:id/status', authorize('admin', 'manager'), updateOrderStatus);
router.patch('/:id/cancel', cancelOrder);

module.exports = router;