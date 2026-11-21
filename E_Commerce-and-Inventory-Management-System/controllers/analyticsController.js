const Order = require('../models/Order');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

/*
 * "Sales" in every analytics endpoint means orders whose status is not "cancelled"
 * (placed, confirmed, shipped and delivered orders). Dates are grouped in UTC.
 */

const round2 = (n) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

const parseDateParam = (value, name, endOfDay = false) => {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new AppError(`${name} must be a date string`, 400, 'VALIDATION_ERROR');
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${name} must be a valid date (YYYY-MM-DD or ISO 8601)`, 400, 'VALIDATION_ERROR');
  }
  return date;
};

// Builds the $match stage shared by all analytics pipelines
const buildSalesMatch = (query) => {
  const startDate = parseDateParam(query.startDate, 'startDate');
  const endDate = parseDateParam(query.endDate, 'endDate', true);

  if (startDate && endDate && startDate > endDate) {
    throw new AppError('startDate must not be after endDate', 400, 'VALIDATION_ERROR');
  }

  const match = { status: { $ne: 'cancelled' } };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }

  return { match, startDate, endDate };
};

/**
 * GET /api/analytics/sales-by-date  (admin, manager)
 * Query: startDate, endDate, groupBy=day|month (default day)
 */
const getSalesByDate = asyncHandler(async (req, res) => {
  const groupBy = req.query.groupBy === undefined ? 'day' : req.query.groupBy;
  if (!['day', 'month'].includes(groupBy)) {
    throw new AppError('groupBy must be "day" or "month"', 400, 'VALIDATION_ERROR');
  }

  const { match, startDate, endDate } = buildSalesMatch(req.query);
  const format = groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format, date: '$createdAt', timezone: 'UTC' } },
        revenue: { $sum: '$totalAmount' },
        orderCount: { $sum: 1 },
        totalDiscounts: { $sum: '$discountAmount' }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  const series = rows.map((row) => ({
    period: row._id,
    revenue: round2(row.revenue),
    orderCount: row.orderCount,
    totalDiscounts: round2(row.totalDiscounts),
    averageOrderValue: row.orderCount > 0 ? round2(row.revenue / row.orderCount) : 0
  }));

  const totalRevenue = series.reduce((sum, s) => sum + s.revenue, 0);
  const totalOrders = series.reduce((sum, s) => sum + s.orderCount, 0);
  const totalDiscounts = series.reduce((sum, s) => sum + s.totalDiscounts, 0);

  res.status(200).json({
    success: true,
    data: {
      groupBy,
      startDate: startDate ? startDate.toISOString() : null,
      endDate: endDate ? endDate.toISOString() : null,
      summary: {
        totalRevenue: round2(totalRevenue),
        totalOrders,
        totalDiscounts: round2(totalDiscounts),
        averageOrderValue: totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0
      },
      series
    }
  });
});

/**
 * GET /api/analytics/sales-by-category  (admin, manager)
 * Query: startDate, endDate (they filter the sales figures; stock figures are always current)
 *
 * netRevenue = grossRevenue minus each order's discount, allocated to its lines in
 * proportion to line value (lineTotal * totalAmount / subtotal).
 */
const getSalesByCategory = asyncHandler(async (req, res) => {
  const { match } = buildSalesMatch(req.query);

  const [salesRows, inventoryRows] = await Promise.all([
    Order.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.category',
          unitsSold: { $sum: '$items.quantity' },
          grossRevenue: { $sum: '$items.lineTotal' },
          netRevenue: {
            $sum: {
              $multiply: [
                '$items.lineTotal',
                { $cond: [{ $gt: ['$subtotal', 0] }, { $divide: ['$totalAmount', '$subtotal'] }, 1] }
              ]
            }
          },
          orderIds: { $addToSet: '$_id' }
        }
      },
      {
        $project: {
          _id: 0,
          category: '$_id',
          unitsSold: 1,
          grossRevenue: 1,
          netRevenue: 1,
          orderCount: { $size: '$orderIds' }
        }
      }
    ]),
    Product.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$category',
          productCount: { $sum: 1 },
          currentStock: { $sum: '$stock' },
          inventoryValuation: { $sum: { $multiply: ['$price', '$stock'] } },
          lowStockItems: { $sum: { $cond: [{ $lte: ['$stock', '$lowStockThreshold'] }, 1, 0] } }
        }
      },
      {
        $project: {
          _id: 0,
          category: '$_id',
          productCount: 1,
          currentStock: 1,
          inventoryValuation: 1,
          lowStockItems: 1
        }
      }
    ])
  ]);

  // Merge sales and inventory by category (a category can appear in only one of them)
  const merged = new Map();
  const ensure = (category) => {
    if (!merged.has(category)) {
      merged.set(category, {
        category,
        unitsSold: 0,
        orderCount: 0,
        grossRevenue: 0,
        netRevenue: 0,
        productCount: 0,
        currentStock: 0,
        inventoryValuation: 0,
        lowStockItems: 0
      });
    }
    return merged.get(category);
  };

  salesRows.forEach((row) => Object.assign(ensure(row.category), row));
  inventoryRows.forEach((row) => Object.assign(ensure(row.category), row));

  const categories = [...merged.values()]
    .map((c) => ({
      ...c,
      grossRevenue: round2(c.grossRevenue),
      netRevenue: round2(c.netRevenue),
      inventoryValuation: round2(c.inventoryValuation)
    }))
    .sort((a, b) => b.netRevenue - a.netRevenue);

  const totals = categories.reduce(
    (acc, c) => ({
      unitsSold: acc.unitsSold + c.unitsSold,
      grossRevenue: acc.grossRevenue + c.grossRevenue,
      netRevenue: acc.netRevenue + c.netRevenue,
      currentStock: acc.currentStock + c.currentStock,
      inventoryValuation: acc.inventoryValuation + c.inventoryValuation,
      lowStockItems: acc.lowStockItems + c.lowStockItems
    }),
    { unitsSold: 0, grossRevenue: 0, netRevenue: 0, currentStock: 0, inventoryValuation: 0, lowStockItems: 0 }
  );

  res.status(200).json({
    success: true,
    data: {
      totals: {
        ...totals,
        grossRevenue: round2(totals.grossRevenue),
        netRevenue: round2(totals.netRevenue),
        inventoryValuation: round2(totals.inventoryValuation)
      },
      categories
    }
  });
});

/**
 * GET /api/analytics/overview  (admin, manager)
 * Query: startDate, endDate (optional)
 * KPI summary: total revenue, total orders, top 5 best-selling products, coupon redemption stats.
 */
const getOverview = asyncHandler(async (req, res) => {
  const { match } = buildSalesMatch(req.query);
  const now = new Date();

  const [facetResult, statusRows, couponTotals, lowStockCount] = await Promise.all([
    // One pass over the matched orders, split into three result sets with $facet
    Order.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: '$totalAmount' },
                totalOrders: { $sum: 1 },
                totalDiscounts: { $sum: '$discountAmount' }
              }
            }
          ],
          topProducts: [
            { $unwind: '$items' },
            {
              $group: {
                _id: '$items.product',
                name: { $first: '$items.name' },
                sku: { $first: '$items.sku' },
                category: { $first: '$items.category' },
                unitsSold: { $sum: '$items.quantity' },
                revenue: { $sum: '$items.lineTotal' }
              }
            },
            { $sort: { unitsSold: -1, revenue: -1 } },
            { $limit: 5 }
          ],
          couponUsage: [
            { $match: { coupon: { $ne: null } } },
            {
              $group: {
                _id: '$couponCode',
                redemptions: { $sum: 1 },
                totalDiscountGiven: { $sum: '$discountAmount' },
                revenueFromOrders: { $sum: '$totalAmount' }
              }
            },
            { $sort: { redemptions: -1 } }
          ]
        }
      }
    ]),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Coupon.aggregate([
      {
        $group: {
          _id: null,
          totalCoupons: { $sum: 1 },
          activeCoupons: {
            $sum: { $cond: [{ $and: ['$isActive', { $gt: ['$expiryDate', now] }] }, 1, 0] }
          },
          totalRedemptions: { $sum: '$usedCount' }
        }
      }
    ]),
    Product.countDocuments({ isActive: true, $expr: { $lte: ['$stock', '$lowStockThreshold'] } })
  ]);

  const facets = facetResult[0] || { totals: [], topProducts: [], couponUsage: [] };
  const totals = facets.totals[0] || { totalRevenue: 0, totalOrders: 0, totalDiscounts: 0 };
  const couponSummary = couponTotals[0] || { totalCoupons: 0, activeCoupons: 0, totalRedemptions: 0 };

  const ordersByStatus = { pending: 0, confirmed: 0, shipped: 0, delivered: 0, cancelled: 0 };
  statusRows.forEach((row) => {
    ordersByStatus[row._id] = row.count;
  });

  res.status(200).json({
    success: true,
    data: {
      totalRevenue: round2(totals.totalRevenue),
      totalOrders: totals.totalOrders,
      totalDiscounts: round2(totals.totalDiscounts),
      averageOrderValue: totals.totalOrders > 0 ? round2(totals.totalRevenue / totals.totalOrders) : 0,
      ordersByStatus,
      lowStockProducts: lowStockCount,
      topProducts: facets.topProducts.map((p) => ({
        productId: p._id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        unitsSold: p.unitsSold,
        revenue: round2(p.revenue)
      })),
      couponStats: {
        totalCoupons: couponSummary.totalCoupons,
        activeCoupons: couponSummary.activeCoupons,
        totalRedemptions: couponSummary.totalRedemptions,
        ordersWithCoupon: facets.couponUsage.reduce((sum, c) => sum + c.redemptions, 0),
        totalDiscountGiven: round2(facets.couponUsage.reduce((sum, c) => sum + c.totalDiscountGiven, 0)),
        byCoupon: facets.couponUsage.map((c) => ({
          code: c._id,
          redemptions: c.redemptions,
          totalDiscountGiven: round2(c.totalDiscountGiven),
          revenueFromOrders: round2(c.revenueFromOrders)
        }))
      }
    }
  });
});

module.exports = { getSalesByDate, getSalesByCategory, getOverview };