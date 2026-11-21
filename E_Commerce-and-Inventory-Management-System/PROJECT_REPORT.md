# E-Commerce and Inventory Management System
## Backend Development Capstone Project Report (Option 4)

| | |
|---|---|
| **Submitted by** | Apurvam (sole developer) |
| **Roll No.** | 2501730032 |
| **Course / Programme** | B.Tech Cse AI/ML |
| **Institution** | K. R. Mangalam University |
| **Technology** | Node.js, Express.js, MongoDB (Mongoose), JWT, Socket.IO |

---

## Declaration

I declare that this project was designed, implemented, tested and documented entirely by me. I was the only developer, so every architectural decision, line of code, test and document in this report is my own work.

---

## Table of Contents

1. Abstract
2. Introduction
3. Requirements Analysis
4. System Design
5. Implementation
6. Security Design
7. Testing
8. Challenges and Solutions
9. Limitations and Future Scope
10. Conclusion
11. References
- Appendix A: Viva Defense Notes
- Appendix B: Live Demo Script

---

## 1. Abstract

This project is a backend system for an online store that also manages its inventory. Customers browse products, apply coupon codes, place orders, write reviews and keep a wishlist. Administrators and managers maintain the catalogue, process orders and watch sales analytics. The central engineering problem is keeping stock correct when many customers buy at once, so stock changes are done with atomic MongoDB updates. Authentication uses short-lived JWT access tokens with rotating refresh tokens, and access is controlled by roles. Side effects such as audit logging, notifications and rating recalculation are decoupled from the HTTP layer with Node's `EventEmitter`, and live updates reach administrators and customers through Socket.IO. Sales and inventory analytics are computed inside the database with aggregation pipelines. The system is verified by a Postman collection of 75 requests with automated assertions, and a single-file browser console demonstrates the real-time behaviour.

## 2. Introduction

### 2.1 Problem Statement
A small online retailer needs a backend that sells products without overselling, enforces who may do what, gives staff real-time visibility into orders and low stock, and supports promotions and customer feedback. Simple CRUD APIs do not meet this because stock is a shared resource that many users change at the same moment.

### 2.2 Objectives
1. Build a secure REST API with role-based access control for customers, managers and admins.
2. Guarantee that stock never goes negative, even under concurrent checkouts.
3. Support the four domain extensions: coupons, reviews, analytics and personalization.
4. Decouple side effects from request handling with an event-driven design.
5. Push live updates to the right users with Socket.IO.
6. Provide a repeatable test suite and a demo client so every feature can be shown.

### 2.3 Scope
**In scope:** the REST API, MongoDB data model, JWT authentication, RBAC, events, sockets, seed data, Postman tests and a demo console.
**Out of scope:** a payment gateway (payment method is only recorded), email delivery, a production front end and deployment automation.

### 2.4 Constraints
The project uses only the core course stack: Node.js (CommonJS), Express, MongoDB with Mongoose, `jsonwebtoken`, `bcrypt`, `cookie-parser`, native `events`, `socket.io`, `dotenv`, `cors` and `morgan`.

## 3. Requirements Analysis

### 3.1 Functional Requirements

| ID | Requirement |
|---|---|
| FR1 | Register, log in, refresh tokens and log out. Roles: customer, manager, admin |
| FR2 | Product CRUD with category, price range, keyword filters, sorting and pagination |
| FR3 | Checkout that validates stock, applies a coupon, decrements stock atomically and creates the order |
| FR4 | Order lifecycle `pending -> confirmed -> shipped -> delivered`, or `cancelled` with stock restored |
| FR5 | Coupons with percentage or flat discounts, minimum order, maximum discount, expiry, global usage limit and one use per user |
| FR6 | Reviews: one per customer per product, rating 1 to 5, verified-purchase flag, automatic rating aggregates |
| FR7 | Analytics: sales by date, sales and inventory by category, overview KPIs |
| FR8 | Wishlist and recommendations with a fallback for new users |
| FR9 | Domain events for orders, status changes, low stock, reviews and coupon redemption |
| FR10 | Real-time Socket.IO notifications to administrators and individual customers |

### 3.2 Non-Functional Requirements

| Area | Requirement |
|---|---|
| Correctness | No negative stock; no coupon redeemed twice by one user or beyond its limit |
| Security | Hashed passwords, hashed refresh tokens, least privilege, input validation |
| Reliability | A failing side effect must never fail the user's request |
| Maintainability | Layered structure, consistent response and error formats |
| Testability | Every endpoint covered by repeatable, automated assertions |

### 3.3 Users and Roles

| Role | Capabilities |
|---|---|
| Customer | Browse, order, cancel own pending or confirmed orders, review, wishlist, recommendations, validate coupons |
| Manager | Everything operational: manage products, view all orders and change statuses, view analytics |
| Admin | Everything a manager can do, plus coupon management and deleting any review |

## 4. System Design

### 4.1 Architecture

```
Client (demo console / Postman)
   |  HTTP                                  |  WebSocket
   v                                        v
Express middleware chain               Socket.IO server (JWT handshake)
 morgan > cors > json > cookieParser    rooms: admin-room, user:<id>
   |                                        ^
   v                                        |
Routes > protect > authorize                |
   v                                        |
Controllers --emit--> eventBus --> listeners (audit, alerts, sockets)
   v                                        |
Mongoose models <---------------------------
   v
MongoDB
```

The system is layered. Routes map URLs to controllers, middleware enforces authentication and roles, controllers hold the business rules, and models hold the schemas. Controllers emit domain events and return, while listeners perform the side effects afterwards.

### 4.2 Technology Choices

| Choice | Reason |
|---|---|
| Express | Minimal, explicit middleware model that is easy to reason about and defend |
| MongoDB and Mongoose | Flexible documents suit order snapshots, and the aggregation framework suits analytics |
| JWT access plus refresh | Stateless API calls with revocable long-lived sessions |
| `EventEmitter` | In-process, zero-dependency decoupling of side effects |
| Socket.IO | Authenticated WebSockets with rooms and automatic reconnection |

### 4.3 Database Design

| Collection | Purpose | Key fields and indexes |
|---|---|---|
| `users` | Accounts | `email` (unique), `role`, hashed `password`, hashed `refreshTokens[]` |
| `products` | Catalogue and inventory | `sku` (unique), `category`+`price`, `stock`, `lowStockThreshold`, `averageRating`, `numReviews`, text index |
| `coupons` | Promotions | `code` (unique), `discountType`, `usageLimit`, `usedCount`, `usedBy[]` |
| `orders` | Purchases | `user`+`createdAt`, `status`+`createdAt`, `items[]` with price and category snapshots, `statusHistory[]` |
| `reviews` | Feedback | Unique (`product`, `user`) so one review per customer per product |
| `wishlists` | Saved products | `user` (unique), `products[]` |
| `auditlogs` | Immutable event trail | `action`+`createdAt`, `entityType`+`entityId` |

Orders store a snapshot of each product's name, SKU, category and price. This keeps order history and revenue analytics correct even if the product is later edited or deactivated.

### 4.4 Order Lifecycle

```
pending --> confirmed --> shipped --> delivered
   |            |
   +------------+--------> cancelled   (stock restored once, coupon released)
```

Transitions are enforced in the model (`Order.canTransition`), and each change is applied with a conditional update so two simultaneous changes cannot both succeed.

## 5. Implementation

### 5.1 Authentication and Sessions
Registration always creates a `customer`, so a client cannot choose its own role. Login returns a 15-minute access token and a 7-day refresh token. The refresh token is also set as an HTTP-only cookie scoped to `/api/auth`. Section 6 explains rotation and revocation.

### 5.2 Role-Based Access Control
`protect` verifies the access token and loads the user from the database. `authorize(...roles)` then checks the role. Because the role is read from the database on each request, deactivating a user or changing a role takes effect immediately.

### 5.3 Product and Inventory Management
Product reads are public and support filters, sorting and pagination. Writes require admin or manager. Request bodies are whitelisted field by field, so a client cannot set `averageRating`, `numReviews` or `createdBy`. Deleting is a soft delete to keep related orders, reviews and wishlists valid.

### 5.4 Checkout and Atomic Inventory (core feature)
Checkout runs these steps:
1. Validate the cart and load live prices from the database.
2. Pre-check stock so the client gets a clear message.
3. Check coupon eligibility.
4. Build and validate the order object before touching stock.
5. For each line, run one atomic update:

```js
Product.findOneAndUpdate(
  { _id, isActive: true, stock: { $gte: quantity } },
  { $inc: { stock: -quantity } },
  { new: true }
);
```

6. If any line returns `null`, restore the lines already decremented and return `409 INSUFFICIENT_STOCK`.
7. Claim the coupon atomically, save the order, then emit `order:placed` and `coupon:redeemed`.

The check and the decrement are one MongoDB operation on one document, so two buyers racing for the last unit cannot both succeed. Cancelling an order restores stock with `$inc` and releases the coupon.

### 5.5 Coupons
`Coupon.checkEligibility` validates active status, expiry, usage limit, per-user use and minimum cart value, then `calculateDiscount` applies the percentage or flat value and the maximum cap. `POST /api/coupons/validate` and checkout share this logic. At checkout the redemption itself is claimed atomically, with the same rules in the update filter, so concurrent checkouts cannot exceed the usage limit or let one user redeem twice.

### 5.6 Reviews and Ratings
A unique index on (`product`, `user`) enforces one review per customer per product. A review is flagged as a verified purchase when the user has a non-cancelled order containing the product. After every create, update or delete, a `review:updated` event triggers an aggregation that recomputes `averageRating` and `numReviews` on the product.

### 5.7 Analytics with Aggregation Pipelines

| Endpoint | Pipeline idea |
|---|---|
| `sales-by-date` | `$match` (non-cancelled, date range) then `$group` by `$dateToString` (day or month) with `$sum` and `$sum: 1`, then `$sort` |
| `sales-by-category` | `$match`, `$unwind` items, `$group` by category (units, gross, net revenue, distinct order count). A second pipeline on products groups stock, valuation (`price * stock`) and low-stock count. Results are merged by category |
| `overview` | `$match`, then one `$facet` producing totals, top 5 products (`$unwind`, `$group`, `$sort`, `$limit`) and coupon usage, plus a status breakdown and coupon totals |

Net revenue is gross revenue minus each order's discount, allocated to its lines in proportion to line value (`lineTotal * totalAmount / subtotal`). This keeps category totals consistent with order totals.

### 5.8 Wishlist and Recommendations
The wishlist add is an atomic conditional `$push`, so duplicates are impossible. The recommendation engine aggregates the categories of the user's past orders and wishlist, then selects the highest-rated in-stock products from those categories, excluding anything already purchased. Each result carries a human-readable reason. If the user has no history, or the personalized list is shorter than requested, the remaining slots are filled with top-rated products overall.

### 5.9 Event-Driven Design

| Event | Reaction |
|---|---|
| `order:placed` | Audit entry, admin notification, stock broadcast, low-stock threshold check |
| `order:statusUpdated` | Audit entry, real-time update to the customer, stock broadcast after a cancel |
| `inventory:lowStock` | Warning audit entry and an alert to administrators |
| `review:updated` | Recalculate rating aggregates |
| `coupon:redeemed` | Audit entry |

Every listener is wrapped so an exception is logged and never propagates, which keeps a failing side effect from affecting the user's response.

### 5.10 Real-Time Layer
Socket.IO authenticates in a handshake middleware using the same token verification as HTTP. Admins and managers join `admin-room`, and every user joins `user:<id>`. Listeners emit `order:new`, `stock:updated` and `alert:lowStock` to the admin room and `order:statusChanged` to the owning customer's room. A single-file demo console opens a staff session and a customer session at once so the event flow between them is visible in one browser tab.

## 6. Security Design

| Threat | Mitigation |
|---|---|
| Password theft | bcrypt hashing with a configurable cost factor; passwords never returned |
| Stolen database | Refresh tokens stored only as SHA-256 hashes |
| Stolen or replayed refresh token | Rotation on every use; reuse of a rotated token revokes all of the user's sessions |
| XSS reading the refresh token | HTTP-only cookie, `SameSite=Lax`, path limited to `/api/auth`, `Secure` flag configurable |
| Token type confusion | Separate secrets for access and refresh tokens; algorithm pinned to HS256 |
| Privilege escalation | Role forced to `customer` on registration; role read from the database per request |
| Mass assignment | Explicit field whitelists on create and update |
| NoSQL injection | Login inputs must be strings; ids validated; search text regex-escaped |
| Account enumeration | Same error for unknown email and wrong password |
| Overselling and double coupon use | Atomic conditional updates |
| Information leakage | Stack traces only outside production; consistent error shape |

## 7. Testing

### 7.1 Strategy
The API is tested with a Postman collection (`postman_collection.json`) of **75 requests in 12 folders**. Every request has `pm.test` assertions, and variables carry ids and tokens between steps. Real-time behaviour is verified manually with the demo console.

### 7.2 Coverage

| Folder | What is verified |
|---|---|
| Health | Service is up |
| Authentication | Registration, duplicate email (409), role escalation blocked, wrong password (401), HttpOnly cookie, profile, token rotation, reuse detection |
| RBAC failures | Missing token (401), malformed token (401), customer blocked from admin routes (403) |
| Catalogue | Search, category and price filters, sorting, pagination, invalid id (400), unknown id (404) |
| Coupon validation | Valid coupon with cap, below minimum, expired, unknown, higher cap |
| Orders and stock | Checkout with coupon and consistent totals, exact stock decrement, single-use coupon (400), insufficient stock (409), validation before stock changes, cancel restores stock, final-state rejection |
| Reviews | Verified purchase, duplicate (409), rating validation (400), update, list, rating recalculated by event, delete restores aggregates |
| Wishlist and recommendations | Add, list, remove, personalized recommendations with purchased items excluded, fallback for a new user |
| Admin | Product create, duplicate SKU, mass-assignment blocked, low-stock list, lifecycle transitions and invalid transition, soft delete, coupon create, immutable code, delete |
| Analytics | KPIs, daily and monthly series with internal consistency checks, invalid parameters (400), category report |
| Manager | Allowed on analytics, blocked on coupon creation (403) |
| Logout | Logout succeeds, revoked token cannot refresh |

### 7.3 Manual Real-Time Tests

| Action | Expected result |
|---|---|
| Customer orders 3 × Wireless Earbuds Pro | Admin receives `order:new`, `stock:updated` and `alert:lowStock`; customer receives nothing |
| Admin advances the order | Only that customer receives `order:statusChanged` |
| Customer cancels | Stock rises and the admin receives `stock:updated` |
| Customer calls an admin API | 403, shown in the log |

## 8. Challenges and Solutions

| Challenge | Solution |
|---|---|
| Preventing overselling without transactions (standalone MongoDB has none) | Conditional atomic `$inc` per product, with compensating rollback if a later line fails |
| Double use of a single-use coupon under concurrency | The coupon claim re-checks every rule in the update filter, so only one request can succeed |
| Refresh-token theft | Rotation plus reuse detection |
| Keeping HTTP responses fast | Side effects moved into event listeners |
| Meaningful analytics after products change | Price and category snapshots stored on each order |
| Showing two roles live in one browser | The demo console keeps two sessions, each with its own tokens and socket |

## 9. Limitations and Future Scope

**Limitations (stated honestly):**
- The rollback of a partially failed checkout is a compensating action, not a database transaction. If the server crashed between the stock decrement and saving the order, stock could stay reduced. Running MongoDB as a replica set and wrapping checkout in a transaction would remove that window.
- `EventEmitter` is in-process, so events are lost if the process stops and cannot be shared across several server instances.
- Socket authentication happens at connection time only, so a socket stays connected after its access token expires until it reconnects.
- There is no rate limiting on login or other endpoints.
- Payments are recorded but not processed.

**Future scope:** MongoDB transactions on a replica set, a message queue and the Socket.IO Redis adapter for multi-instance deployment, rate limiting and account lockout, email notifications, a payment gateway and a production front end.

## 10. Conclusion

I built a complete e-commerce and inventory backend that meets every functional requirement and the four domain extensions. The most important result is correctness under concurrency: stock and coupons are protected by atomic database operations. The security design covers password hashing, rotating and revocable refresh tokens, role checks against the database and input whitelisting. The event-driven design keeps controllers small and responses fast, and Socket.IO gives staff and customers live updates. The system is backed by 75 automated Postman requests and a demo console. Working on it alone gave me ownership of the whole lifecycle: design, implementation, testing and documentation.

## 11. References

1. MongoDB Documentation: CRUD operations, `findOneAndUpdate`, and the Aggregation Framework (`$match`, `$group`, `$unwind`, `$lookup`, `$facet`).
2. Mongoose Documentation: schemas, validation, middleware and statics.
3. Express.js Documentation: routing and error-handling middleware.
4. RFC 7519: JSON Web Token (JWT).
5. OWASP Cheat Sheets: Password Storage, JSON Web Token, Authorization, Mass Assignment.
6. Node.js Documentation: `events` module and `crypto` module.
7. Socket.IO Documentation: server API, rooms and middleware.
8. Postman Documentation: test scripts and collection variables.

---

# Appendix A: Viva Defense Notes

## A.1 Concurrency and Atomic Stock Updates

**Core answer:** "Overselling is a race condition. If I read the stock, check it in application code and then write it back, two requests can both read 1 and both succeed. I avoid read-then-write. The check and the decrement happen in one atomic MongoDB operation."

```js
Product.findOneAndUpdate(
  { _id, isActive: true, stock: { $gte: qty } },   // the guard
  { $inc: { stock: -qty } },                       // the change
  { new: true }
);
```

- MongoDB applies a single-document update atomically. If the guard fails, nothing changes and I get `null`, which I turn into `409 INSUFFICIENT_STOCK`.
- `$inc` increments on the server, so there is no stale value from the application. A `save()` with a computed value would be a lost-update bug.
- Multi-line orders are decremented line by line. If line 3 fails, I run a compensating `$inc` for lines 1 and 2.
- The same idea protects coupons: the claim has `usedBy: { $ne: user }` and a `usedCount < usageLimit` check in the update filter.
- The order status change is a conditional update on the status I read, so two admins cannot both move the same order.

**Likely questions**
- *Why not transactions?* A standalone local MongoDB does not support multi-document transactions (they need a replica set). Single-document atomic updates are enough for the inventory rule, and I documented the crash-window limitation honestly.
- *What if two people buy the last unit?* One update matches the guard and the other gets `null`, so one order succeeds and the other receives a 409.
- *Why a pre-check if the atomic update is the real guard?* It gives a friendly error that lists the available quantity. It is a convenience, not the protection.
- *Why validate the order before decrementing stock?* So bad input fails cleanly without any rollback (the Postman suite proves stock is unchanged after a failed checkout).
- *What about cancel?* The status change is conditional, and the stock restore only runs for the single request that wins the transition, so stock cannot be restored twice.

## A.2 JWT Refresh Security

**Core answer:** "The access token is short-lived (15 minutes) and stateless. The refresh token lives 7 days, is signed with a different secret, and is stored only as a SHA-256 hash in the user's document, so it can be revoked."

- **Rotation:** every refresh consumes the presented token and issues a new pair.
- **Reuse detection:** a validly signed token that is not stored means it was already used, which suggests theft. I revoke all of that user's sessions.
- **Storage:** HTTP-only cookie (invisible to JavaScript, so XSS cannot read it), `SameSite=Lax`, path `/api/auth` so it is not sent to other routes, and `Secure` when HTTPS is on.
- **Hashing:** if the database leaks, the stored hashes cannot be used as tokens.
- **Unique tokens:** each refresh token carries a random `jti`, so two tokens issued in the same second still differ.
- **Roles from the database:** the access token carries the role, but the server loads the user and uses the stored role, so a demoted or deactivated user loses access immediately.
- **Logout:** removes the token hash, so the token cannot be refreshed even though it has not expired.

**Likely questions**
- *Why two tokens?* A short access token limits damage if it leaks, and a revocable refresh token gives a long session without forcing repeated logins.
- *Why not store refresh tokens in localStorage?* Any XSS could steal them. An HTTP-only cookie cannot be read by scripts.
- *Why different secrets?* So an access token can never be accepted as a refresh token or the reverse.
- *Weakness?* There is no rate limiting yet, and an access token stays valid until it expires even after logout, which is the cost of being stateless.

## A.3 EventEmitter vs Socket.IO

**Core answer:** "They solve different problems at different layers. `EventEmitter` is an in-process publish and subscribe bus inside my server. Socket.IO is a network channel between the server and browsers. `EventEmitter` decouples my code, and Socket.IO delivers to people."

| | EventEmitter | Socket.IO |
|---|---|---|
| Boundary | Inside one Node process | Server to browser over WebSocket |
| Purpose | Decouple controllers from side effects | Push live updates to clients |
| Delivery | Synchronous call of listeners, in memory | Network, with rooms and reconnection |
| In my code | `order:placed`, `inventory:lowStock`, ... | `order:new`, `alert:lowStock`, ... |

- The controller emits `order:placed` and returns the response. The listener writes the audit log, checks thresholds and calls Socket.IO. The controller knows nothing about sockets or audit logs.
- A new reaction (for example sending email) means adding a listener, with no change to checkout.
- Listeners are wrapped so an error never breaks the request. In the other direction, Socket.IO is only used inside listeners.
- Rooms give targeting: `admin-room` for staff, `user:<id>` for one customer.

**Likely questions**
- *Why not emit sockets directly from the controller?* That couples business logic to the transport and makes the controller slow and harder to test.
- *Limitation of EventEmitter?* It is in-memory and single-process. Events are lost on a crash and are not shared between instances. A queue such as Redis or RabbitMQ would fix that.
- *Is the audit log guaranteed?* It is best effort. A failure is logged but does not fail the order.

## A.4 MongoDB Aggregation Pipelines

**Core answer:** "I let the database do the heavy lifting. A pipeline is a series of stages where each stage transforms the documents from the previous one."

- **Sales by date:** `$match` filters non-cancelled orders in the date range. `$group` uses `$dateToString` as the key (`%Y-%m-%d` or `%Y-%m`) and sums revenue, counts orders and sums discounts. `$sort` orders the periods. Average order value is computed from revenue and count.
- **Sales by category:** `$unwind` splits each order into one document per item, then `$group` by the category snapshot stored on the item. A separate pipeline on products groups stock, valuation and low-stock counts. I merge both by category. Net revenue allocates each order's discount across its lines by value.
- **Overview:** one `$facet` runs three sub-pipelines over the same matched orders (totals, top 5 products, coupon usage), so the orders collection is scanned once.
- **Recommendations:** group the user's order items by category, `$lookup` the wishlist products to get their categories, then `$match`, `$sort` by rating and `$limit` for the final list.
- **Ratings:** `$group` with `$avg` and `$sum` recomputes a product's `averageRating` and `numReviews`.

**Likely questions**
- *Why aggregation instead of loading data and looping in JavaScript?* Less data over the wire, faster, and it uses indexes where possible.
- *Why snapshot category and price on the order?* So analytics stay correct if a product changes, and no `$lookup` is needed for sales reports.
- *`$match` first, why?* It reduces the documents early and can use an index.
- *Difference between `$group` and `$facet`?* `$group` aggregates one result set. `$facet` runs several independent pipelines on the same input.

## A.5 More Quick Answers

- **Why soft delete products?** Orders, reviews and wishlists reference them. Deleting would break history.
- **Why is the role forced to customer on registration?** Otherwise anyone could register as an admin. The Postman suite tests this.
- **How is one review per user per product guaranteed?** A unique compound index on (`product`, `user`), plus a friendly pre-check.
- **How do you know a purchase is verified?** The user has a non-cancelled order containing the product.
- **What would you do with more time?** Replica-set transactions, a queue for events, rate limiting and a real front end.

---

# Appendix B: Live Demo Script (about 5 minutes)

1. Run `npm run seed`, then `npm run dev`, and open `http://localhost:5000`.
2. Login as **Admin** and as **Customer**. Show both connections and their rooms.
3. **Browse Products**: point out the amber low-stock badges.
4. Order **3 × Wireless Earbuds Pro** with `WELCOME10`. Show `order:new`, `stock:updated` and `alert:lowStock` in the admin log, and that the customer log stays quiet.
5. **Update Order Status** and show `order:statusChanged` arriving only at the customer.
6. **Cancel** an order and show the stock returning.
7. **Fetch Analytics & Recommendations** and explain the pipelines behind each table.
8. Click **RBAC check** to show 401 and 403 responses.
9. Open Postman and run the collection to show 75 requests passing.