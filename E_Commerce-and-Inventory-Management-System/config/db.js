const mongoose = require('mongoose');
require('dotenv').config();

// Reject queries with unknown fields instead of silently ignoring them
mongoose.set('strictQuery', true);

let listenersAttached = false;

const attachConnectionListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    console.log(`[DB] MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
  });

  mongoose.connection.on('error', (err) => {
    console.error(`[DB] MongoDB connection error: ${err.message}`);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[DB] MongoDB disconnected');
  });
};

/**
 * Connects to MongoDB using MONGO_URI from the environment.
 * Exits the process with code 1 if the connection cannot be established.
 */
const connectDB = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error('[DB] MONGO_URI is not defined. Copy .env.example to .env and set it.');
    process.exit(1);
  }

  attachConnectionListeners();

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 20,
      autoIndex: process.env.NODE_ENV !== 'production'
    });
    return mongoose.connection;
  } catch (err) {
    console.error(`[DB] Initial connection failed: ${err.message}`);
    console.error('[DB] Make sure MongoDB is running locally and MONGO_URI is correct.');
    process.exit(1);
  }
};

/**
 * Closes the MongoDB connection (used for graceful shutdown and by the seed script).
 */
const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    console.log('[DB] MongoDB connection closed');
  }
};

module.exports = { connectDB, disconnectDB };