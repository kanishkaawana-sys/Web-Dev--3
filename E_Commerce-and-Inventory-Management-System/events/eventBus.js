const EventEmitter = require('events');

// Domain event names, used identically by controllers and listeners
const EVENTS = Object.freeze({
  ORDER_PLACED: 'order:placed',
  ORDER_STATUS_UPDATED: 'order:statusUpdated',
  INVENTORY_LOW_STOCK: 'inventory:lowStock',
  REVIEW_UPDATED: 'review:updated',
  COUPON_REDEEMED: 'coupon:redeemed'
});

const DOMAIN_EVENT_NAMES = new Set(Object.values(EVENTS));

class AppEventBus extends EventEmitter {
  emit(eventName, ...args) {
    // Log only our domain events (not internal ones like "newListener")
    if (process.env.NODE_ENV !== 'production' && DOMAIN_EVENT_NAMES.has(eventName)) {
      console.log(`[EVENT] ${eventName}`);
    }
    return super.emit(eventName, ...args);
  }
}

// Single shared instance (Node's module cache makes this a singleton)
const eventBus = new AppEventBus();
eventBus.setMaxListeners(20);

module.exports = { eventBus, EVENTS };