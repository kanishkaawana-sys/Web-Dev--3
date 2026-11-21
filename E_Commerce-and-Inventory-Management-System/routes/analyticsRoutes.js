const express = require('express');
const { getSalesByDate, getSalesByCategory, getOverview } = require('../controllers/analyticsController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');

const router = express.Router();

router.use(protect, authorize('admin', 'manager'));

router.get('/sales-by-date', getSalesByDate);
router.get('/sales-by-category', getSalesByCategory);
router.get('/overview', getOverview);

module.exports = router;