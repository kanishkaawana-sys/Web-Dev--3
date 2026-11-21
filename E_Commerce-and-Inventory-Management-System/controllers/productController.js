const Product = require('../models/Product');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { eventBus, EVENTS } = require('../events/eventBus');

const CREATE_FIELDS = ['name', 'description', 'sku', 'category', 'price', 'stock', 'lowStockThreshold', 'imageUrl'];
const UPDATE_FIELDS = [...CREATE_FIELDS, 'isActive'];

const SORT_OPTIONS = {
  newest: { createdAt: -1, _id: 1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  rating: { averageRating: -1, numReviews: -1, _id: 1 },
  popularity: { numReviews: -1, averageRating: -1, _id: 1 },
  name_asc: { name: 1, _id: 1 },
  name_desc: { name: -1, _id: 1 }
};

// Whitelist body fields so clients can never set averageRating, numReviews, createdBy, etc.
const pickFields = (source, fields) => {
  const picked = {};
  fields.forEach((field) => {
    if (source && source[field] !== undefined) picked[field] = source[field];
  });
  return picked;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePagination = (query, defaultLimit = 10, maxLimit = 100) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

const parseNumberParam = (value, name) => {
  const number = Number(value);
  if (Number.isNaN(number)) {
    throw new AppError(`${name} must be a number`, 400, 'VALIDATION_ERROR');
  }
  return number;
};

// Emits inventory:lowStock when a product sits at or below its threshold
const emitLowStockIfNeeded = (product) => {
  if (product.isActive && product.stock <= product.lowStockThreshold) {
    eventBus.emit(EVENTS.INVENTORY_LOW_STOCK, {
      productId: String(product._id),
      name: product.name,
      sku: product.sku,
      stock: product.stock,
      lowStockThreshold: product.lowStockThreshold
    });
  }
};

/**
 * GET /api/products  (public)
 * Query: category (comma separated), minPrice, maxPrice, search, inStock=true, minRating,
 *        sort (newest|price_asc|price_desc|rating|popularity|name_asc|name_desc), page, limit
 */
const getProducts = asyncHandler(async (req, res) => {
  const { category, minPrice, maxPrice, search, inStock, minRating, sort } = req.query;
  const filter = { isActive: true };

  if (typeof category === 'string' && category.trim()) {
    const categories = category.split(',').map((c) => c.trim()).filter(Boolean);
    filter.category = { $in: categories.map((c) => new RegExp(`^${escapeRegex(c)}$`, 'i')) };
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) filter.price.$gte = parseNumberParam(minPrice, 'minPrice');
    if (maxPrice !== undefined) filter.price.$lte = parseNumberParam(maxPrice, 'maxPrice');
  }

  if (typeof search === 'string' && search.trim()) {
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ name: regex }, { description: regex }, { sku: regex }, { category: regex }];
  }

  if (inStock === 'true') filter.stock = { $gt: 0 };
  if (minRating !== undefined) filter.averageRating = { $gte: parseNumberParam(minRating, 'minRating') };

  const sortOrder = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;
  const { page, limit, skip } = parsePagination(req.query);

  const [products, total] = await Promise.all([
    Product.find(filter).sort(sortOrder).skip(skip).limit(limit),
    Product.countDocuments(filter)
  ]);

  res.status(200).json({
    success: true,
    count: products.length,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    data: products
  });
});

/**
 * GET /api/products/low-stock  (admin, manager)
 * Active products where stock <= lowStockThreshold, lowest stock first.
 */
const getLowStockProducts = asyncHandler(async (req, res) => {
  const products = await Product.find({
    isActive: true,
    $expr: { $lte: ['$stock', '$lowStockThreshold'] }
  }).sort({ stock: 1, name: 1 });

  res.status(200).json({ success: true, count: products.length, data: products });
});

/**
 * GET /api/products/:id  (public)
 */
const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, isActive: true });
  if (!product) {
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }
  res.status(200).json({ success: true, data: product });
});

/**
 * POST /api/products  (admin, manager)
 */
const createProduct = asyncHandler(async (req, res) => {
  const product = await Product.create({
    ...pickFields(req.body, CREATE_FIELDS),
    createdBy: req.user._id
  });

  emitLowStockIfNeeded(product);

  res.status(201).json({ success: true, message: 'Product created', data: product });
});

/**
 * PUT /api/products/:id  (admin, manager)
 * "stock" here is an absolute value set by the manager (a stock-take or restock).
 * Customer purchases use atomic $inc updates in orderController.
 */
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }

  const updates = pickFields(req.body, UPDATE_FIELDS);
  if (Object.keys(updates).length === 0) {
    throw new AppError('No valid fields provided to update', 400, 'VALIDATION_ERROR');
  }

  product.set(updates);
  await product.save();

  if (updates.stock !== undefined || updates.lowStockThreshold !== undefined) {
    emitLowStockIfNeeded(product);
  }

  res.status(200).json({ success: true, message: 'Product updated', data: product });
});

/**
 * DELETE /api/products/:id  (admin, manager)
 * Soft delete: the product disappears from the catalogue but orders, reviews and
 * wishlists that reference it stay valid.
 */
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }

  product.isActive = false;
  await product.save();

  res.status(200).json({ success: true, message: 'Product deactivated', data: product });
});

module.exports = {
  getProducts,
  getLowStockProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct
};