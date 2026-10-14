# Test schemas

Local MySQL databases used to exercise Querywell’s three engine paths. Recreated by `scripts/seed-tier-databases.js`. Measured values below are from the live databases on this machine (14 Oct 2026).

## Recreate

```bash
node scripts/seed-tier-databases.js
```

The script drops and rebuilds the three databases, then creates a shared read-only user.

## Connection

Use these credentials in Database Source. They have `SELECT` only.

| Field | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `3306` |
| Username | `nlq_tier_ro` |
| Password | `nlq-tier-readonly` |
| Databases | `nlq_tier_starter`, `nlq_tier_growth`, `nlq_tier_scale` |

## Databases and engine fit

Schema character count is what `choosePath()` uses (`src/engine/route.js`):

- **small / Starter** — ≤ 30,000 characters, full schema in the prompt
- **medium / Growth** — 30,001–120,000 characters, Qdrant retrieval + compact table-name list
- **large / Scale** — > 120,000 characters, Qdrant retrieval only

| Database | Plan path | Schema chars | Tables | Generated modules | Extra |
|---|---|---|---|---|---|
| `nlq_tier_starter` | small → Starter | 12,134 | 66 | 12 (`m001`–`m012`) | Core commerce only |
| `nlq_tier_growth` | medium → Growth | 45,222 | 242 | 56 (`m001`–`m056`) | Core + modules |
| `nlq_tier_scale` | large → Scale | 130,493 | 695 | 169 (`m001`–`m169`) | Core + modules + `sales_ledger` (100,000 rows) |

Target bands in the seeder: Starter 12k–28k, Growth 45k–110k, Scale 130k–190k.

## Shared core model (18 tables)

Every tier has the same commerce schema. Generated `mNNN_*` tables sit beside this core to inflate schema text.

```
departments
    └── employees.department_id

customers
    ├── customer_addresses.customer_id
    ├── orders.customer_id
    └── sales_ledger.customer_id          (Scale only)

product_categories
    └── products.category_id
            ├── inventory_levels.product_id
            ├── order_items.product_id
            ├── purchase_order_items.product_id
            └── sales_ledger.product_id   (Scale only)

warehouses
    ├── inventory_levels.warehouse_id
    └── shipments.warehouse_id

order_statuses                          (lookup: pending, paid, shipped, cancelled)

orders
    ├── order_items.order_id
    ├── payments.order_id
    ├── shipments.order_id
    ├── invoices.order_id
    └── sales_ledger.order_id             (Scale only)

payments
    └── refunds.payment_id

suppliers
    └── purchase_orders.supplier_id
            └── purchase_order_items.purchase_order_id
```

### Core columns

| Table | Columns |
|---|---|
| `departments` | `id` PK, `code`, `name` |
| `employees` | `id` PK, `department_id` → `departments.id`, `full_name`, `title`, `email`, `hired_at` |
| `customers` | `id` PK, `full_name`, `email`, `status_code`, `country_code`, `created_at` |
| `customer_addresses` | `id` PK, `customer_id` → `customers.id`, `city`, `region_code`, `postal_code`, `country_code` |
| `suppliers` | `id` PK, `name`, `status_code`, `country_code` |
| `warehouses` | `id` PK, `code`, `name`, `city` |
| `product_categories` | `id` PK, `code`, `name` |
| `products` | `id` PK, `category_id` → `product_categories.id`, `sku`, `name`, `unit_price`, `active_flag`, `created_at` |
| `inventory_levels` | `id` PK, `warehouse_id` → `warehouses.id`, `product_id` → `products.id`, `on_hand_qty`, `reserved_qty` |
| `order_statuses` | `id` PK, `code`, `label` |
| `orders` | `id` PK, `customer_id` → `customers.id`, `status_code`, `currency_code`, `subtotal_amount`, `tax_amount`, `total_amount`, `ordered_at` |
| `order_items` | `id` PK, `order_id` → `orders.id`, `product_id` → `products.id`, `quantity`, `unit_price`, `line_total` |
| `payments` | `id` PK, `order_id` → `orders.id`, `amount`, `method_code`, `status_code`, `paid_at` |
| `refunds` | `id` PK, `payment_id` → `payments.id`, `amount`, `status_code`, `refunded_at` |
| `shipments` | `id` PK, `order_id` → `orders.id`, `warehouse_id` → `warehouses.id`, `status_code`, `shipped_at` |
| `invoices` | `id` PK, `order_id` → `orders.id`, `status_code`, `total_amount`, `issued_at` |
| `purchase_orders` | `id` PK, `supplier_id` → `suppliers.id`, `status_code`, `total_amount`, `ordered_at` |
| `purchase_order_items` | `id` PK, `purchase_order_id` → `purchase_orders.id`, `product_id` → `products.id`, `quantity`, `unit_cost` |

Types: `id` is `BIGINT AUTO_INCREMENT`. Money is `DECIMAL(12,2)`. Dates are `DATETIME`. Codes and names are `VARCHAR(120)`.

## Seeded core rows (all tiers)

| Table | Rows | Notes |
|---|---:|---|
| `departments` | 4 | sales, ops, finance, support |
| `employees` | 40 | titles Manager / Specialist |
| `customers` | 2,000 | `status_code` active/inactive; countries US, CA, GB, DE |
| `customer_addresses` | 2,000 | one per customer |
| `suppliers` | 25 | US, CN, DE |
| `warehouses` | 3 | Austin, Toronto, London |
| `product_categories` | 3 | hardware, software, service |
| `products` | 400 | SKU-1000…; `active_flag` 0 every 11th product |
| `inventory_levels` | 400 | one row per product |
| `order_statuses` | 4 | pending, paid, shipped, cancelled |
| `orders` | 5,000 | currency USD; statuses rotate |
| `order_items` | 15,000 | ~3 lines per order |
| `payments` | 5,000 | card / ach / wire; every 4th is `failed` |
| `refunds` | 200 | |
| `shipments` | 3,500 | every 5th is `pending` |
| `invoices` | 5,000 | every 6th is `open` |
| `purchase_orders` | 300 | |
| `purchase_order_items` | 900 | |

Useful lookup values when writing studio prompts:

- order / payment-like statuses: `pending`, `paid`, `shipped`, `cancelled`, `failed`, `refunded`, `open`, `received`
- customer status: `active`, `inactive`
- countries: `US`, `CA`, `GB`, `DE`
- payment methods: `card`, `ach`, `wire`
- product SKUs: `SKU-1000` through `SKU-1399`

## Generated modules (`mNNN_*`)

Each module `mNNN` (zero-padded, starting at `m001`) adds four tables. They exist only to grow schema text and retrieval surface; they are not part of the commerce story.

```
mNNN_accounts
    └── mNNN_records.account_id
            ├── mNNN_lines.record_id
            └── mNNN_events.record_id
```

| Table | Columns |
|---|---|
| `mNNN_accounts` | `id` PK, `code`, `name`, `status_code`, `region_code`, `opened_at` |
| `mNNN_records` | `id` PK, `account_id` → `mNNN_accounts.id`, `code`, `status_code`, `amount`, `quantity`, `occurred_at` |
| `mNNN_lines` | `id` PK, `record_id` → `mNNN_records.id`, `sku`, `quantity`, `unit_amount`, `line_total` |
| `mNNN_events` | `id` PK, `record_id` → `mNNN_records.id`, `event_code`, `notes`, `occurred_at` |

Rows per module (`moduleRows` in the seeder):

| Database | Accounts | Records | Lines | Events |
|---|---:|---:|---:|---:|
| Starter | 40 | 120 | 120 | 40 |
| Growth | 80 | 240 | 240 | 80 |
| Scale | 120 | 360 | 360 | 120 |

Account `status_code`: `open` / `closed`. Regions: `east`, `west`, `north`, `south`. Event codes: `created`, `updated`, `closed`.

## Scale-only ledger

| Table | Columns |
|---|---|
| `sales_ledger` | `id` PK, `customer_id` → `customers.id`, `product_id` → `products.id`, `order_id` → `orders.id`, `amount`, `quantity`, `status_code`, `booked_at` |

100,000 rows. Statuses rotate through `pending`, `paid`, `shipped`, `cancelled`.

## Example questions that hit the core tables

These work on all three databases:

- How many orders have a paid status?
- Which 5 customers generated the highest total revenue?
- Show recent orders over $500 with customer name and status
- Count all customers and orders
- Show total invoices grouped by status
- List products that are inactive

Growth and Scale also accept module questions such as “how many open accounts are in `m001_accounts`?” — those tables are not in Starter beyond `m012`.

## Appendix: path-proof schema

`scripts/prove-paths.js` builds a separate tiny database (`nlq_path_proof` by default) for unit-style path checks. It is not used by the product UI.

```
customers (id, desk_name)
order_status (status_code, description)
products (id, sku, product_name)
orders (id, customer_id → customers.id, status_code → order_status.status_code, ordered_on)
order_items (id, order_id → orders.id, product_id → products.id, qty)
```

Seeded rows: 2 customers (North Desk, South Desk), 3 statuses (`P` paid, `O` open, `S` shipped), 2 products (Lamp, Chair), 3 orders, 2 order items.

## Source of truth

Table and seed definitions live in `scripts/seed-tier-databases.js`. If the live databases drift, rerun that script and update the measured character counts in the table above.
