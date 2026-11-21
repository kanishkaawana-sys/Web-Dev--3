require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const { connectDB, disconnectDB } = require('./config/db');
const { initSocket, getIO } = require('./sockets/socketHandler');
const { registerListeners } = require('./events/listeners');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const couponRoutes = require('./routes/couponRoutes');
const orderRoutes = require('./routes/orderRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const wishlistRoutes = require('./routes/wishlistRoutes');
const recommendationRoutes = require('./routes/recommendationRoutes');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Fail fast if essential configuration is missing
const REQUIRED_ENV = ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`[SERVER] Missing required environment variables: ${missingEnv.join(', ')}`);
  console.error('[SERVER] Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();
app.disable('x-powered-by');

// ---------- Global middleware ----------
app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(
  cors({
    // Requests without an Origin header (Postman, curl, same-origin) are allowed
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Real-time demo console (public/index.html)
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Routes ----------
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'E-Commerce & Inventory API is running',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/recommendations', recommendationRoutes);
// Serves /api/products/:productId/reviews and /api/reviews/:reviewId
app.use('/api', reviewRoutes);

// ---------- Error handling (must be last) ----------
app.use(notFound);
app.use(errorHandler);

// ---------- Startup ----------
let server;

const start = async () => {
  await connectDB();

  // Domain event listeners must be registered before the first request arrives
  registerListeners();

  // Socket.IO shares the same HTTP server and port as Express
  server = http.createServer(app);
  initSocket(server);

  server.listen(PORT, () => {
    console.log(`[SERVER] Running in ${process.env.NODE_ENV || 'development'} mode on http://localhost:${PORT}`);
    console.log(`[SERVER] Demo console: http://localhost:${PORT}/`);
    console.log(`[SERVER] Health check: http://localhost:${PORT}/api/health`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[SERVER] Port ${PORT} is already in use. Change PORT in .env.`);
    } else {
      console.error(`[SERVER] Server error: ${err.message}`);
    }
    process.exit(1);
  });
};

// ---------- Graceful shutdown ----------
let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[SERVER] ${signal} received. Shutting down gracefully...`);

  // Force exit if something hangs
  const forceTimer = setTimeout(() => {
    console.error('[SERVER] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  try {
    try {
      getIO().close();
    } catch (err) {
      // Socket.IO was never initialised
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectDB();
    console.log('[SERVER] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error(`[SERVER] Error during shutdown: ${err.message}`);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] Unhandled promise rejection:', reason);
});

start().catch((err) => {
  console.error(`[SERVER] Failed to start: ${err.message}`);
  process.exit(1);
});

module.exports = app;