const express = require('express');
const {
  getProducts,
  getLowStockProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct
} = require('../controllers/productController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');

const router = express.Router();

// Public catalogue
router.get('/', getProducts);

// Must be declared before "/:id" so "low-stock" is not treated as an id
router.get('/low-stock', protect, authorize('admin', 'manager'), getLowStockProducts);

router.get('/:id', getProductById);

// Inventory management
router.post('/', protect, authorize('admin', 'manager'), createProduct);
router.put('/:id', protect, authorize('admin', 'manager'), updateProduct);
router.delete('/:id', protect, authorize('admin', 'manager'), deleteProduct);

module.exports = router;