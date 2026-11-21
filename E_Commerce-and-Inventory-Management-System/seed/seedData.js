require('dotenv').config();

const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const Order = require('../models/Order');
const Review = require('../models/Review');
const Wishlist = require('../models/Wishlist');
const AuditLog = require('../models/AuditLog');

/*
 * Usage:
 *   npm run seed            wipes all collections and loads fresh demo data
 *   npm run seed:destroy    wipes all collections and exits
 *   add --force             required to run when NODE_ENV=production
 */
const args = process.argv.slice(2);
const DESTROY_ONLY = args.includes('--destroy');
const FORCE = args.includes('--force');

// ---------- Deterministic random numbers, so every seed run produces the same data ----------
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(20261114);
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (probability) => rand() < probability;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);
const daysFromNow = (days) => new Date(Date.now() + days * DAY);

// ---------- Static seed data ----------
const USER_SEED = [
  { key: 'admin', name: 'Admin User', email: 'admin@shop.com', password: 'Admin@123', role: 'admin' },
  { key: 'manager', name: 'Store Manager', email: 'manager@shop.com', password: 'Manager@123', role: 'manager' },
  { key: 'demo', name: 'Demo Customer', email: 'customer@shop.com', password: 'Customer@123', role: 'customer' },
  { key: 'priya', name: 'Priya Sharma', email: 'priya@example.com', password: 'Customer@123', role: 'customer' },
  { key: 'rahul', name: 'Rahul Verma', email: 'rahul@example.com', password: 'Customer@123', role: 'customer' },
  { key: 'sneha', name: 'Sneha Iyer', email: 'sneha@example.com', password: 'Customer@123', role: 'customer' },
  { key: 'arjun', name: 'Arjun Mehta', email: 'arjun@example.com', password: 'Customer@123', role: 'customer' }
];

const ADDRESSES = {
  demo: { fullName: 'Demo Customer', phone: '9000000001', line1: '12 MG Road', line2: '', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'India' },
  priya: { fullName: 'Priya Sharma', phone: '9000000002', line1: '45 Linking Road', line2: 'Bandra West', city: 'Mumbai', state: 'Maharashtra', postalCode: '400050', country: 'India' },
  rahul: { fullName: 'Rahul Verma', phone: '9000000003', line1: '8 Connaught Place', line2: '', city: 'New Delhi', state: 'Delhi', postalCode: '110001', country: 'India' },
  sneha: { fullName: 'Sneha Iyer', phone: '9000000004', line1: '22 Anna Salai', line2: '', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600002', country: 'India' },
  arjun: { fullName: 'Arjun Mehta', phone: '9000000005', line1: '5 Park Street', line2: '', city: 'Kolkata', state: 'West Bengal', postalCode: '700016', country: 'India' }
};

// Items marked LOW start at or below their threshold, so the dashboards show low-stock alerts straight away.
// ELEC-001 sits just above its threshold, so ordering 3 units triggers a live low-stock alert in the demo.
const PRODUCT_SEED = [
  // Electronics
  { sku: 'ELEC-001', name: 'Wireless Earbuds Pro', category: 'Electronics', price: 2499, stock: 12, lowStockThreshold: 10, description: 'Active noise cancellation, 30-hour battery life and a wireless charging case.' },
  { sku: 'ELEC-002', name: 'Smartwatch Fit 2', category: 'Electronics', price: 4999, stock: 25, lowStockThreshold: 8, description: 'AMOLED display, heart-rate and sleep tracking, 7-day battery.' },
  { sku: 'ELEC-003', name: 'Bluetooth Speaker Mini', category: 'Electronics', price: 1799, stock: 4, lowStockThreshold: 8, description: 'Pocket-sized, waterproof speaker with 12 hours of playtime. (LOW)' },
  { sku: 'ELEC-004', name: '20000mAh Power Bank', category: 'Electronics', price: 1599, stock: 60, lowStockThreshold: 15, description: 'Fast-charging power bank with dual USB-C ports.' },
  { sku: 'ELEC-005', name: 'Mechanical Keyboard K87', category: 'Electronics', price: 3499, stock: 18, lowStockThreshold: 6, description: 'Tenkeyless hot-swappable mechanical keyboard with RGB backlight.' },
  { sku: 'ELEC-006', name: '4K Action Camera', category: 'Electronics', price: 7999, stock: 9, lowStockThreshold: 5, description: '4K 60fps, image stabilisation and a waterproof housing.' },
  // Fashion
  { sku: 'FASH-001', name: "Men's Cotton Polo T-Shirt", category: 'Fashion', price: 799, stock: 80, lowStockThreshold: 20, description: 'Breathable pure cotton polo in a regular fit.' },
  { sku: 'FASH-002', name: "Women's Denim Jacket", category: 'Fashion', price: 2299, stock: 30, lowStockThreshold: 10, description: 'Classic mid-wash denim jacket with a relaxed fit.' },
  { sku: 'FASH-003', name: 'Classic Leather Wallet', category: 'Fashion', price: 999, stock: 45, lowStockThreshold: 12, description: 'Genuine leather bifold wallet with RFID protection.' },
  { sku: 'FASH-004', name: 'Running Shoes AirLite', category: 'Fashion', price: 3299, stock: 3, lowStockThreshold: 5, description: 'Lightweight cushioned running shoes. (LOW)' },
  // Home & Kitchen
  { sku: 'HOME-001', name: 'Air Fryer 4L', category: 'Home & Kitchen', price: 5499, stock: 7, lowStockThreshold: 8, description: 'Digital air fryer with 8 presets and a 4 litre basket. (LOW)' },
  { sku: 'HOME-002', name: 'Stainless Steel Water Bottle 1L', category: 'Home & Kitchen', price: 699, stock: 120, lowStockThreshold: 25, description: 'Double-wall vacuum insulated, keeps drinks cold for 24 hours.' },
  { sku: 'HOME-003', name: 'Non-stick Cookware Set (5 pcs)', category: 'Home & Kitchen', price: 2999, stock: 22, lowStockThreshold: 6, description: 'Induction-friendly non-stick set with glass lids.' },
  { sku: 'HOME-004', name: 'LED Desk Lamp', category: 'Home & Kitchen', price: 1299, stock: 40, lowStockThreshold: 10, description: 'Dimmable desk lamp with three colour temperatures and a USB port.' },
  { sku: 'HOME-005', name: 'Memory Foam Pillow', category: 'Home & Kitchen', price: 1199, stock: 35, lowStockThreshold: 10, description: 'Ergonomic cervical pillow with a washable cover.' },
  // Books
  { sku: 'BOOK-001', name: 'Mastering Node.js Backend Development', category: 'Books', price: 899, stock: 50, lowStockThreshold: 10, description: 'Build production-grade REST APIs with Express, MongoDB and JWT.' },
  { sku: 'BOOK-002', name: 'Deep Learning Fundamentals', category: 'Books', price: 1099, stock: 40, lowStockThreshold: 10, description: 'A practical introduction to neural networks with worked examples.' },
  { sku: 'BOOK-003', name: 'Algorithms Made Simple', category: 'Books', price: 749, stock: 65, lowStockThreshold: 15, description: 'Core data structures and algorithms explained step by step.' },
  { sku: 'BOOK-004', name: 'The Startup Playbook', category: 'Books', price: 499, stock: 90, lowStockThreshold: 20, description: 'Lessons on building and funding early-stage companies.' },
  // Sports & Fitness
  { sku: 'SPRT-001', name: 'Anti-Slip Yoga Mat', category: 'Sports & Fitness', price: 899, stock: 0, lowStockThreshold: 5, description: '6mm eco-friendly yoga mat with a carry strap. (OUT OF STOCK)' },
  { sku: 'SPRT-002', name: 'Adjustable Dumbbell Set 20kg', category: 'Sports & Fitness', price: 3999, stock: 14, lowStockThreshold: 5, description: 'Quick-adjust dumbbells from 2kg to 20kg.' },
  { sku: 'SPRT-003', name: 'Resistance Bands Set', category: 'Sports & Fitness', price: 599, stock: 70, lowStockThreshold: 15, description: 'Five resistance levels with handles and a door anchor.' },
  { sku: 'SPRT-004', name: 'Skipping Rope Pro', category: 'Sports & Fitness', price: 349, stock: 100, lowStockThreshold: 20, description: 'Ball-bearing speed rope with adjustable length.' },
  // Beauty & Personal Care
  { sku: 'BEAU-001', name: 'Vitamin C Face Serum', category: 'Beauty & Personal Care', price: 649, stock: 55, lowStockThreshold: 15, description: '10% Vitamin C serum for brighter skin.' },
  { sku: 'BEAU-002', name: 'Electric Beard Trimmer', category: 'Beauty & Personal Care', price: 1499, stock: 28, lowStockThreshold: 8, description: 'Cordless trimmer with 20 length settings and a 90-minute runtime.' },
  { sku: 'BEAU-003', name: 'Herbal Shampoo 500ml', category: 'Beauty & Personal Care', price: 399, stock: 8, lowStockThreshold: 10, description: 'Sulphate-free herbal shampoo for daily use. (LOW)' }
];

const COUPON_SEED = [
  { code: 'WELCOME10', description: '10% off orders above 500 (max discount 200)', discountType: 'percentage', discountValue: 10, minOrderAmount: 500, maxDiscountAmount: 200, expiryDate: daysFromNow(90), usageLimit: 100, isActive: true },
  { code: 'FLAT200', description: 'Flat 200 off orders above 1500', discountType: 'flat', discountValue: 200, minOrderAmount: 1500, maxDiscountAmount: null, expiryDate: daysFromNow(60), usageLimit: null, isActive: true },
  { code: 'BIGSALE25', description: '25% off orders above 3000 (max discount 1000)', discountType: 'percentage', discountValue: 25, minOrderAmount: 3000, maxDiscountAmount: 1000, expiryDate: daysFromNow(30), usageLimit: 50, isActive: true },
  { code: 'ONLYONE100', description: 'Flat 100 off orders above 300. Only one redemption in total.', discountType: 'flat', discountValue: 100, minOrderAmount: 300, maxDiscountAmount: null, expiryDate: daysFromNow(45), usageLimit: 1, isActive: true },
  { code: 'EXPIRED20', description: '20% off (expired 10 days ago)', discountType: 'percentage', discountValue: 20, minOrderAmount: 0, maxDiscountAmount: 300, expiryDate: daysFromNow(-10), usageLimit: 100, isActive: true },
  { code: 'INACTIVE15', description: '15% off (switched off by admin)', discountType: 'percentage', discountValue: 15, minOrderAmount: 0, maxDiscountAmount: 250, expiryDate: daysFromNow(30), usageLimit: 100, isActive: false }
];

// Coupons used in the generated order history (never ONLYONE100, so the demo can still redeem it)
const HISTORY_COUPON_CODES = ['WELCOME10', 'FLAT200', 'BIGSALE25', 'EXPIRED20'];

// Scripted history for the demo customer: Electronics, Books and Sports, so recommendations are personalised.
// The demo customer never used a coupon, never wrote a review, and has one pending order for the admin demo.
const DEMO_ORDER_SEED = [
  { daysAgo: 62, status: 'delivered', lines: [['ELEC-001', 1], ['BOOK-001', 1]] },
  { daysAgo: 40, status: 'delivered', lines: [['BOOK-002', 1], ['BOOK-003', 1]] },
  { daysAgo: 21, status: 'delivered', lines: [['SPRT-001', 1], ['SPRT-003', 1]] },
  { daysAgo: 5, status: 'shipped', lines: [['SPRT-004', 2]] },
  { daysAgo: 1, status: 'pending', lines: [['ELEC-004', 1]] }
];

const DEMO_WISHLIST_SKUS = ['ELEC-002', 'FASH-002', 'HOME-002'];

const GENERATED_ORDER_COUNT = 45;
const GENERATED_CUSTOMERS = ['priya', 'rahul', 'sneha', 'arjun'];

const REVIEW_TEXT = {
  5: {
    titles: ['Absolutely love it', 'Excellent quality', 'Worth every rupee', 'Highly recommended'],
    comments: ['Exceeded my expectations. Great build quality and fast delivery.', 'Perfect in every way. Would happily buy again.', 'Brilliant product at this price. Totally satisfied.']
  },
  4: {
    titles: ['Very good product', 'Solid purchase', 'Good value', 'Happy with it'],
    comments: ['Works as described. A small improvement here and there would make it perfect.', 'Good quality for the price. Delivery was on time.', 'Does the job well and feels durable.']
  },
  3: {
    titles: ['Decent for the price', 'Average', 'Does the job'],
    comments: ['It is okay. Nothing special, but it works.', 'Average quality. Fine for occasional use.']
  },
  2: {
    titles: ['Not as expected', 'Could be better'],
    comments: ['The quality is below what the description suggested.', 'Had a few issues after a week of use.']
  },
  1: {
    titles: ['Disappointed', 'Poor quality'],
    comments: ['Stopped working properly very quickly.', 'Not worth the money. Would not recommend.']
  }
};

const weightedRating = () => {
  const r = rand();
  if (r < 0.05) return 1;
  if (r < 0.12) return 2;
  if (r < 0.3) return 3;
  if (r < 0.65) return 4;
  return 5;
};

// ---------- Helpers ----------
const STATUS_PATH = {
  pending: ['pending'],
  confirmed: ['pending', 'confirmed'],
  shipped: ['pending', 'confirmed', 'shipped'],
  delivered: ['pending', 'confirmed', 'shipped', 'delivered'],
  cancelled: ['pending', 'cancelled']
};
const STATUS_NOTES = {
  pending: 'Order placed',
  confirmed: 'Order confirmed',
  shipped: 'Dispatched from warehouse',
  delivered: 'Delivered to customer',
  cancelled: 'Cancelled by customer'
};
const STATUS_DELAY_HOURS = { pending: 0, confirmed: 6, shipped: 30, delivered: 78, cancelled: 10 };

const chooseStatus = (daysAgo) => {
  const r = rand();
  if (daysAgo > 14) return r < 0.88 ? 'delivered' : 'cancelled';
  if (daysAgo > 7) return r < 0.55 ? 'delivered' : r < 0.85 ? 'shipped' : 'cancelled';
  if (daysAgo > 3) return r < 0.4 ? 'shipped' : r < 0.8 ? 'confirmed' : r < 0.9 ? 'delivered' : 'cancelled';
  return r < 0.45 ? 'pending' : r < 0.9 ? 'confirmed' : 'cancelled';
};

const buildStatusHistory = (customerId, createdAt, finalStatus, staffIds) =>
  STATUS_PATH[finalStatus].map((status, index) => ({
    status,
    changedBy: index === 0 ? customerId : staffIds[index % staffIds.length],
    changedAt: new Date(Math.min(createdAt.getTime() + STATUS_DELAY_HOURS[status] * HOUR, Date.now())),
    note: STATUS_NOTES[status]
  }));

const wipeDatabase = async () => {
  await Promise.all([
    AuditLog.deleteMany({}),
    Review.deleteMany({}),
    Wishlist.deleteMany({}),
    Order.deleteMany({}),
    Coupon.deleteMany({}),
    Product.deleteMany({}),
    User.deleteMany({})
  ]);
  console.log('[SEED] All collections cleared');
};

// ---------- Seeding steps ----------
const seedUsers = async () => {
  // create() (not insertMany) so the bcrypt pre-save hook hashes every password
  const docs = await User.create(USER_SEED.map(({ key, ...fields }) => fields));
  const users = {};
  USER_SEED.forEach((entry, index) => {
    users[entry.key] = docs[index];
  });
  console.log(`[SEED] Users created: ${docs.length}`);
  return users;
};

const seedProducts = async (admin) => {
  const docs = await Product.create(PRODUCT_SEED.map((p) => ({ ...p, createdBy: admin._id })));
  const bySku = {};
  docs.forEach((doc) => {
    bySku[doc.sku] = doc;
  });
  console.log(`[SEED] Products created: ${docs.length}`);
  return { products: docs, bySku };
};

const seedCoupons = async (admin) => {
  const docs = await Coupon.create(COUPON_SEED.map((c) => ({ ...c, createdBy: admin._id })));
  const byCode = {};
  docs.forEach((doc) => {
    byCode[doc.code] = doc;
  });
  console.log(`[SEED] Coupons created: ${docs.length}`);
  return byCode;
};

const seedOrders = async ({ users, products, bySku, couponsByCode }) => {
  const staffIds = [users.manager._id, users.admin._id];
  const createdOrders = []; // { order, userKey }
  const couponUses = {}; // code -> [userId]
  const usedPairs = new Set(); // `${userKey}:${code}`

  const saveOrder = async ({ userKey, daysAgo, hour, lines, status }) => {
    const user = users[userKey];
    const createdAt = new Date(startOfToday.getTime() - daysAgo * DAY + hour * HOUR + randInt(0, 59) * 60000);

    const items = lines.map(({ product, quantity }) => ({
      product: product._id,
      name: product.name,
      sku: product.sku,
      category: product.category,
      price: product.price,
      quantity
    }));
    const subtotal = round2(items.reduce((sum, item) => sum + item.price * item.quantity, 0));

    // Generated customers sometimes redeem an eligible coupon, once per coupon, never on cancelled orders
    let coupon = null;
    let discountAmount = 0;
    if (userKey !== 'demo' && status !== 'cancelled' && chance(0.35)) {
      const candidates = HISTORY_COUPON_CODES.map((code) => couponsByCode[code]).filter(
        (c) => c.isActive && subtotal >= c.minOrderAmount && createdAt < c.expiryDate && !usedPairs.has(`${userKey}:${c.code}`)
      );
      if (candidates.length > 0) {
        coupon = pick(candidates);
        discountAmount = coupon.calculateDiscount(subtotal);
        usedPairs.add(`${userKey}:${coupon.code}`);
        (couponUses[coupon.code] = couponUses[coupon.code] || []).push(user._id);
      }
    }

    const statusHistory = buildStatusHistory(user._id, createdAt, status, staffIds);
    const lastChange = statusHistory[statusHistory.length - 1].changedAt;

    const order = new Order({
      user: user._id,
      items,
      shippingAddress: ADDRESSES[userKey],
      paymentMethod: pick(['cod', 'card', 'upi']),
      coupon: coupon ? coupon._id : undefined,
      couponCode: coupon ? coupon.code : undefined,
      discountAmount,
      status,
      statusHistory,
      stockRestored: status === 'cancelled',
      deliveredAt: status === 'delivered' ? lastChange : undefined,
      cancelledAt: status === 'cancelled' ? lastChange : undefined,
      createdAt,
      updatedAt: lastChange
    });

    // timestamps:false keeps the historical createdAt/updatedAt values set above
    await order.save({ timestamps: false });
    createdOrders.push({ order, userKey });
  };

  // 1. Scripted orders for the demo customer
  for (const spec of DEMO_ORDER_SEED) {
    await saveOrder({
      userKey: 'demo',
      daysAgo: spec.daysAgo,
      hour: randInt(9, 20),
      status: spec.status,
      lines: spec.lines.map(([sku, quantity]) => ({ product: bySku[sku], quantity }))
    });
  }

  // 2. Generated history for the other customers, spread over about 80 days
  for (let i = 0; i < GENERATED_ORDER_COUNT; i += 1) {
    const daysAgo = randInt(1, 80);
    const lineCount = randInt(1, 3);

    const chosen = new Map();
    while (chosen.size < lineCount) {
      const product = pick(products);
      if (!chosen.has(product.sku)) {
        chosen.set(product.sku, { product, quantity: product.price > 3000 ? 1 : randInt(1, 3) });
      }
    }

    await saveOrder({
      userKey: pick(GENERATED_CUSTOMERS),
      daysAgo,
      hour: randInt(8, 22),
      status: chooseStatus(daysAgo),
      lines: [...chosen.values()]
    });
  }

  // 3. Coupon counters derived from the orders above, so they match exactly
  for (const [code, userIds] of Object.entries(couponUses)) {
    await Coupon.updateOne({ code }, { $set: { usedCount: userIds.length, usedBy: userIds } });
  }

  console.log(`[SEED] Orders created: ${createdOrders.length}`);
  return createdOrders;
};

const seedReviews = async ({ users, products, createdOrders }) => {
  const reviewed = new Set(); // `${userId}:${productId}`
  const purchased = {}; // userKey -> Set of productId strings (non-cancelled orders)
  const reviewDocs = [];

  createdOrders.forEach(({ order, userKey }) => {
    if (order.status === 'cancelled') return;
    purchased[userKey] = purchased[userKey] || new Set();
    order.items.forEach((item) => purchased[userKey].add(String(item.product)));
  });

  const buildReview = (userKey, productId, createdAt, isVerifiedPurchase) => {
    const rating = weightedRating();
    const text = REVIEW_TEXT[rating];
    return {
      product: productId,
      user: users[userKey]._id,
      rating,
      title: pick(text.titles),
      comment: pick(text.comments),
      isVerifiedPurchase,
      createdAt,
      updatedAt: createdAt
    };
  };

  // Verified reviews: only from delivered orders, never for the demo customer
  createdOrders.forEach(({ order, userKey }) => {
    if (order.status !== 'delivered' || userKey === 'demo') return;
    order.items.forEach((item) => {
      const key = `${order.user}:${item.product}`;
      if (reviewed.has(key) || !chance(0.5)) return;
      reviewed.add(key);
      const createdAt = new Date(Math.min(Date.now(), order.deliveredAt.getTime() + randInt(1, 5) * DAY));
      reviewDocs.push(buildReview(userKey, item.product, createdAt, true));
    });
  });

  // Two unverified reviews (the reviewer never bought the product), to show the isVerifiedPurchase flag
  ['priya', 'arjun'].forEach((userKey) => {
    const owned = purchased[userKey] || new Set();
    const candidate = products.find((p) => !owned.has(String(p._id)) && !reviewed.has(`${users[userKey]._id}:${p._id}`));
    if (candidate) {
      reviewed.add(`${users[userKey]._id}:${candidate._id}`);
      reviewDocs.push(buildReview(userKey, candidate._id, new Date(Date.now() - randInt(1, 20) * DAY), false));
    }
  });

  for (const doc of reviewDocs) {
    await new Review(doc).save({ timestamps: false });
  }

  // Same aggregation the review:updated listener uses at runtime
  for (const product of products) {
    await Review.calcAverageRating(product._id);
  }

  console.log(`[SEED] Reviews created: ${reviewDocs.length} (product ratings recalculated)`);
  return reviewDocs.length;
};

const seedWishlists = async ({ users, products, bySku }) => {
  const entries = [];

  entries.push({
    user: users.demo._id,
    products: DEMO_WISHLIST_SKUS.map((sku) => ({ product: bySku[sku]._id, addedAt: new Date(Date.now() - randInt(1, 15) * DAY) }))
  });

  GENERATED_CUSTOMERS.forEach((userKey) => {
    const chosen = new Set();
    const target = randInt(2, 4);
    while (chosen.size < target) chosen.add(pick(products)._id);
    entries.push({
      user: users[userKey]._id,
      products: [...chosen].map((productId) => ({ product: productId, addedAt: new Date(Date.now() - randInt(1, 30) * DAY) }))
    });
  });

  await Wishlist.create(entries);
  console.log(`[SEED] Wishlists created: ${entries.length}`);
};

const printSummary = ({ products, createdOrders, reviewCount }) => {
  const statusCounts = {};
  createdOrders.forEach(({ order }) => {
    statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;
  });
  const lowStock = products.filter((p) => p.stock <= p.lowStockThreshold);

  console.log('\n==================== SEED COMPLETE ====================');
  console.log(`Users: ${USER_SEED.length} | Products: ${products.length} | Coupons: ${COUPON_SEED.length} | Orders: ${createdOrders.length} | Reviews: ${reviewCount}`);
  console.log(`Order statuses: ${Object.entries(statusCounts).map(([s, n]) => `${s}=${n}`).join(', ')}`);

  console.log('\nLogin accounts:');
  console.log('  admin     admin@shop.com      Admin@123');
  console.log('  manager   manager@shop.com    Manager@123');
  console.log('  customer  customer@shop.com   Customer@123');
  console.log('  (also priya@, rahul@, sneha@, arjun@example.com, all with Customer@123)');

  console.log('\nLow-stock products at seed time:');
  lowStock.forEach((p) => console.log(`  ${p.sku}  ${p.name}  stock=${p.stock} (threshold ${p.lowStockThreshold})`));
  console.log('Demo alert trigger: order 3 x "Wireless Earbuds Pro" (ELEC-001, stock 12, threshold 10).');

  console.log('\nCoupons for the demo:');
  console.log('  WELCOME10 (valid) | FLAT200 (min 1500) | BIGSALE25 (min 3000) | ONLYONE100 (1 use in total)');
  console.log('  EXPIRED20 (expired) | INACTIVE15 (inactive)');
  console.log('\nNext: npm run dev, then open http://localhost:5000');
  console.log('=======================================================\n');
};

// ---------- Entry point ----------
const main = async () => {
  if (process.env.NODE_ENV === 'production' && !FORCE) {
    console.error('[SEED] Refusing to run with NODE_ENV=production. Add --force if you really mean it.');
    process.exitCode = 1;
    return;
  }

  await connectDB();

  try {
    // Make sure unique indexes exist before inserting
    await Promise.all([User, Product, Coupon, Order, Review, Wishlist, AuditLog].map((model) => model.init()));

    await wipeDatabase();
    if (DESTROY_ONLY) {
      console.log('[SEED] Destroy complete');
      return;
    }

    const users = await seedUsers();
    const { products, bySku } = await seedProducts(users.admin);
    const couponsByCode = await seedCoupons(users.admin);
    const createdOrders = await seedOrders({ users, products, bySku, couponsByCode });
    const reviewCount = await seedReviews({ users, products, createdOrders });
    await seedWishlists({ users, products, bySku });

    printSummary({ products: await Product.find().sort({ sku: 1 }), createdOrders, reviewCount });
  } catch (err) {
    console.error(`[SEED] Failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
};

main();