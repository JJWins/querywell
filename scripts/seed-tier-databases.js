import "dotenv/config";
import mysql from "mysql2/promise";
import { schemaToText } from "../src/index/schema.js";
import { assertReadOnly } from "../src/index/readonly.js";
import { choosePath } from "../src/engine/route.js";
import { planForPath } from "../src/billing/plans.js";

const USER = "nlq_tier_ro";
const PASSWORD = "nlq-tier-readonly";
const DATABASES = [
  { name: "nlq_tier_starter", min: 12000, max: 28000, ledgerRows: 0, moduleRows: 40 },
  { name: "nlq_tier_growth", min: 45000, max: 110000, ledgerRows: 0, moduleRows: 80 },
  { name: "nlq_tier_scale", min: 130000, max: 190000, ledgerRows: 100000, moduleRows: 120 },
];

const CORE = [
  table("departments", [
    col("id", "bigint", { key: "PRI" }),
    col("code", "varchar"),
    col("name", "varchar"),
  ]),
  table("employees", [
    col("id", "bigint", { key: "PRI" }),
    col("department_id", "bigint", { references: "departments.id" }),
    col("full_name", "varchar"),
    col("title", "varchar"),
    col("email", "varchar"),
    col("hired_at", "datetime"),
  ]),
  table("customers", [
    col("id", "bigint", { key: "PRI" }),
    col("full_name", "varchar"),
    col("email", "varchar"),
    col("status_code", "varchar"),
    col("country_code", "varchar"),
    col("created_at", "datetime"),
  ]),
  table("customer_addresses", [
    col("id", "bigint", { key: "PRI" }),
    col("customer_id", "bigint", { references: "customers.id" }),
    col("city", "varchar"),
    col("region_code", "varchar"),
    col("postal_code", "varchar"),
    col("country_code", "varchar"),
  ]),
  table("suppliers", [
    col("id", "bigint", { key: "PRI" }),
    col("name", "varchar"),
    col("status_code", "varchar"),
    col("country_code", "varchar"),
  ]),
  table("warehouses", [
    col("id", "bigint", { key: "PRI" }),
    col("code", "varchar"),
    col("name", "varchar"),
    col("city", "varchar"),
  ]),
  table("product_categories", [
    col("id", "bigint", { key: "PRI" }),
    col("code", "varchar"),
    col("name", "varchar"),
  ]),
  table("products", [
    col("id", "bigint", { key: "PRI" }),
    col("category_id", "bigint", { references: "product_categories.id" }),
    col("sku", "varchar"),
    col("name", "varchar"),
    col("unit_price", "decimal"),
    col("active_flag", "int"),
    col("created_at", "datetime"),
  ]),
  table("inventory_levels", [
    col("id", "bigint", { key: "PRI" }),
    col("warehouse_id", "bigint", { references: "warehouses.id" }),
    col("product_id", "bigint", { references: "products.id" }),
    col("on_hand_qty", "int"),
    col("reserved_qty", "int"),
  ]),
  table("order_statuses", [
    col("id", "bigint", { key: "PRI" }),
    col("code", "varchar"),
    col("label", "varchar"),
  ]),
  table("orders", [
    col("id", "bigint", { key: "PRI" }),
    col("customer_id", "bigint", { references: "customers.id" }),
    col("status_code", "varchar"),
    col("currency_code", "varchar"),
    col("subtotal_amount", "decimal"),
    col("tax_amount", "decimal"),
    col("total_amount", "decimal"),
    col("ordered_at", "datetime"),
  ]),
  table("order_items", [
    col("id", "bigint", { key: "PRI" }),
    col("order_id", "bigint", { references: "orders.id" }),
    col("product_id", "bigint", { references: "products.id" }),
    col("quantity", "int"),
    col("unit_price", "decimal"),
    col("line_total", "decimal"),
  ]),
  table("payments", [
    col("id", "bigint", { key: "PRI" }),
    col("order_id", "bigint", { references: "orders.id" }),
    col("amount", "decimal"),
    col("method_code", "varchar"),
    col("status_code", "varchar"),
    col("paid_at", "datetime"),
  ]),
  table("refunds", [
    col("id", "bigint", { key: "PRI" }),
    col("payment_id", "bigint", { references: "payments.id" }),
    col("amount", "decimal"),
    col("status_code", "varchar"),
    col("refunded_at", "datetime"),
  ]),
  table("shipments", [
    col("id", "bigint", { key: "PRI" }),
    col("order_id", "bigint", { references: "orders.id" }),
    col("warehouse_id", "bigint", { references: "warehouses.id" }),
    col("status_code", "varchar"),
    col("shipped_at", "datetime"),
  ]),
  table("invoices", [
    col("id", "bigint", { key: "PRI" }),
    col("order_id", "bigint", { references: "orders.id" }),
    col("status_code", "varchar"),
    col("total_amount", "decimal"),
    col("issued_at", "datetime"),
  ]),
  table("purchase_orders", [
    col("id", "bigint", { key: "PRI" }),
    col("supplier_id", "bigint", { references: "suppliers.id" }),
    col("status_code", "varchar"),
    col("total_amount", "decimal"),
    col("ordered_at", "datetime"),
  ]),
  table("purchase_order_items", [
    col("id", "bigint", { key: "PRI" }),
    col("purchase_order_id", "bigint", { references: "purchase_orders.id" }),
    col("product_id", "bigint", { references: "products.id" }),
    col("quantity", "int"),
    col("unit_cost", "decimal"),
  ]),
];

function col(column, type, extra = {}) {
  return { column, type, key: extra.key || "", references: extra.references };
}

function table(name, columns) {
  return { name, columns };
}

function moduleTables(index) {
  const id = String(index).padStart(3, "0");
  const prefix = `m${id}`;
  return [
    table(`${prefix}_accounts`, [
      col("id", "bigint", { key: "PRI" }),
      col("code", "varchar"),
      col("name", "varchar"),
      col("status_code", "varchar"),
      col("region_code", "varchar"),
      col("opened_at", "datetime"),
    ]),
    table(`${prefix}_records`, [
      col("id", "bigint", { key: "PRI" }),
      col("account_id", "bigint", { references: `${prefix}_accounts.id` }),
      col("code", "varchar"),
      col("status_code", "varchar"),
      col("amount", "decimal"),
      col("quantity", "int"),
      col("occurred_at", "datetime"),
    ]),
    table(`${prefix}_lines`, [
      col("id", "bigint", { key: "PRI" }),
      col("record_id", "bigint", { references: `${prefix}_records.id` }),
      col("sku", "varchar"),
      col("quantity", "int"),
      col("unit_amount", "decimal"),
      col("line_total", "decimal"),
    ]),
    table(`${prefix}_events`, [
      col("id", "bigint", { key: "PRI" }),
      col("record_id", "bigint", { references: `${prefix}_records.id` }),
      col("event_code", "varchar"),
      col("notes", "varchar"),
      col("occurred_at", "datetime"),
    ]),
  ];
}

function ledgerTable() {
  return table("sales_ledger", [
    col("id", "bigint", { key: "PRI" }),
    col("customer_id", "bigint", { references: "customers.id" }),
    col("product_id", "bigint", { references: "products.id" }),
    col("order_id", "bigint", { references: "orders.id" }),
    col("amount", "decimal"),
    col("quantity", "int"),
    col("status_code", "varchar"),
    col("booked_at", "datetime"),
  ]);
}

function buildTables(moduleCount, includeLedger) {
  const tables = [...CORE];
  for (let i = 1; i <= moduleCount; i += 1) tables.push(...moduleTables(i));
  if (includeLedger) tables.push(ledgerTable());
  return tables;
}

function toSchema(tables) {
  const schema = {};
  for (const item of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
    schema[item.name] = item.columns;
  }
  return schema;
}

function charsFor(moduleCount, includeLedger) {
  return schemaToText(toSchema(buildTables(moduleCount, includeLedger))).length;
}

function moduleCountFor(spec) {
  const includeLedger = spec.ledgerRows > 0;
  let count = 0;
  while (charsFor(count, includeLedger) < spec.min) count += 1;
  const chars = charsFor(count, includeLedger);
  if (chars > spec.max) {
    throw new Error(`${spec.name} landed at ${chars} characters, above ${spec.max}.`);
  }
  return count;
}

function sqlType(type) {
  if (type === "bigint") return "BIGINT";
  if (type === "int") return "INT";
  if (type === "decimal") return "DECIMAL(12,2)";
  if (type === "datetime") return "DATETIME";
  return "VARCHAR(120)";
}

function createSql(item) {
  const lines = item.columns.map((column) => {
    const pieces = [`\`${column.column}\` ${sqlType(column.type)}`];
    if (column.key === "PRI") pieces.push("NOT NULL AUTO_INCREMENT");
    else if (column.type === "datetime" || column.type === "decimal" || column.type === "int") {
      pieces.push("NOT NULL");
    } else pieces.push("NULL");
    return pieces.join(" ");
  });
  lines.push("PRIMARY KEY (`id`)");
  for (const column of item.columns) {
    if (!column.references) continue;
    const [parent, parentColumn] = column.references.split(".");
    lines.push(
      `KEY \`${column.column}\` (\`${column.column}\`)`,
      `CONSTRAINT \`fk_${item.name}_${column.column}\` FOREIGN KEY (\`${column.column}\`) REFERENCES \`${parent}\` (\`${parentColumn}\`)`
    );
  }
  return `CREATE TABLE \`${item.name}\` (\n  ${lines.join(",\n  ")}\n) ENGINE=InnoDB`;
}

async function insertBatch(conn, tableName, columns, rows) {
  const width = columns.length;
  const tuple = `(${columns.map(() => "?").join(",")})`;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const sql = `INSERT INTO \`${tableName}\` (${columns.map((name) => `\`${name}\``).join(",")}) VALUES ${batch.map(() => tuple).join(",")}`;
    await conn.query(sql, batch.flat());
    if (batch[0].length !== width) throw new Error(`Column mismatch for ${tableName}.`);
  }
}

function stamp(index) {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, index % 86400)).toISOString().slice(0, 19).replace("T", " ");
}

const STATUSES = ["pending", "paid", "shipped", "cancelled"];

async function loadCore(conn) {
  await insertBatch(conn, "departments", ["code", "name"], [
    ["sales", "Sales"],
    ["ops", "Operations"],
    ["finance", "Finance"],
    ["support", "Support"],
  ]);
  await insertBatch(conn, "employees", ["department_id", "full_name", "title", "email", "hired_at"],
    Array.from({ length: 40 }, (_, i) => [
      (i % 4) + 1,
      `Employee ${i + 1}`,
      i % 5 === 0 ? "Manager" : "Specialist",
      `employee${i + 1}@example.com`,
      stamp(i * 1000),
    ])
  );
  await insertBatch(conn, "customers", ["full_name", "email", "status_code", "country_code", "created_at"],
    Array.from({ length: 2000 }, (_, i) => [
      `Customer ${i + 1}`,
      `customer${i + 1}@example.com`,
      i % 17 === 0 ? "inactive" : "active",
      ["US", "CA", "GB", "DE"][i % 4],
      stamp(i),
    ])
  );
  await insertBatch(conn, "customer_addresses", ["customer_id", "city", "region_code", "postal_code", "country_code"],
    Array.from({ length: 2000 }, (_, i) => [
      i + 1,
      ["Austin", "Toronto", "London", "Berlin"][i % 4],
      ["TX", "ON", "LND", "BE"][i % 4],
      String(10000 + i),
      ["US", "CA", "GB", "DE"][i % 4],
    ])
  );
  await insertBatch(conn, "suppliers", ["name", "status_code", "country_code"],
    Array.from({ length: 25 }, (_, i) => [`Supplier ${i + 1}`, "active", ["US", "CN", "DE"][i % 3]])
  );
  await insertBatch(conn, "warehouses", ["code", "name", "city"], [
    ["AUS", "Austin Warehouse", "Austin"],
    ["TOR", "Toronto Warehouse", "Toronto"],
    ["LON", "London Warehouse", "London"],
  ]);
  await insertBatch(conn, "product_categories", ["code", "name"], [
    ["hardware", "Hardware"],
    ["software", "Software"],
    ["service", "Service"],
  ]);
  await insertBatch(conn, "products", ["category_id", "sku", "name", "unit_price", "active_flag", "created_at"],
    Array.from({ length: 400 }, (_, i) => [
      (i % 3) + 1,
      `SKU-${1000 + i}`,
      `Product ${i + 1}`,
      ((i * 17) % 250) + 5,
      i % 11 === 0 ? 0 : 1,
      stamp(i * 10),
    ])
  );
  await insertBatch(conn, "inventory_levels", ["warehouse_id", "product_id", "on_hand_qty", "reserved_qty"],
    Array.from({ length: 400 }, (_, i) => [(i % 3) + 1, i + 1, 20 + (i % 80), i % 7])
  );
  await insertBatch(conn, "order_statuses", ["code", "label"], STATUSES.map((code) => [code, code]));
  await insertBatch(conn, "orders", ["customer_id", "status_code", "currency_code", "subtotal_amount", "tax_amount", "total_amount", "ordered_at"],
    Array.from({ length: 5000 }, (_, i) => {
      const subtotal = ((i * 13) % 400) + 20;
      const tax = Math.round(subtotal * 8) / 100;
      return [
        (i % 2000) + 1,
        STATUSES[i % STATUSES.length],
        "USD",
        subtotal,
        tax,
        subtotal + tax,
        stamp(i * 3),
      ];
    })
  );
  await insertBatch(conn, "order_items", ["order_id", "product_id", "quantity", "unit_price", "line_total"],
    Array.from({ length: 15000 }, (_, i) => {
      const quantity = (i % 4) + 1;
      const unit = ((i * 9) % 80) + 5;
      return [(i % 5000) + 1, (i % 400) + 1, quantity, unit, quantity * unit];
    })
  );
  await insertBatch(conn, "payments", ["order_id", "amount", "method_code", "status_code", "paid_at"],
    Array.from({ length: 5000 }, (_, i) => [
      i + 1,
      ((i * 13) % 400) + 20,
      ["card", "ach", "wire"][i % 3],
      i % 4 === 3 ? "failed" : "paid",
      stamp(i * 3 + 1),
    ])
  );
  await insertBatch(conn, "refunds", ["payment_id", "amount", "status_code", "refunded_at"],
    Array.from({ length: 200 }, (_, i) => [i * 20 + 1, 15 + (i % 30), "refunded", stamp(i * 50)])
  );
  await insertBatch(conn, "shipments", ["order_id", "warehouse_id", "status_code", "shipped_at"],
    Array.from({ length: 3500 }, (_, i) => [i + 1, (i % 3) + 1, i % 5 === 0 ? "pending" : "shipped", stamp(i * 4)])
  );
  await insertBatch(conn, "invoices", ["order_id", "status_code", "total_amount", "issued_at"],
    Array.from({ length: 5000 }, (_, i) => [i + 1, i % 6 === 0 ? "open" : "paid", ((i * 13) % 400) + 20, stamp(i * 3 + 2)])
  );
  await insertBatch(conn, "purchase_orders", ["supplier_id", "status_code", "total_amount", "ordered_at"],
    Array.from({ length: 300 }, (_, i) => [(i % 25) + 1, i % 4 === 0 ? "open" : "received", 500 + i, stamp(i * 20)])
  );
  await insertBatch(conn, "purchase_order_items", ["purchase_order_id", "product_id", "quantity", "unit_cost"],
    Array.from({ length: 900 }, (_, i) => [(i % 300) + 1, (i % 400) + 1, (i % 10) + 1, (i % 40) + 2])
  );
}

async function loadModules(conn, moduleCount, rowsEach) {
  for (let index = 1; index <= moduleCount; index += 1) {
    const id = String(index).padStart(3, "0");
    const prefix = `m${id}`;
    await insertBatch(conn, `${prefix}_accounts`, ["code", "name", "status_code", "region_code", "opened_at"],
      Array.from({ length: rowsEach }, (_, i) => [
        `${prefix}-${i + 1}`,
        `${prefix} account ${i + 1}`,
        i % 8 === 0 ? "closed" : "open",
        ["east", "west", "north", "south"][i % 4],
        stamp(index * 100 + i),
      ])
    );
    await insertBatch(conn, `${prefix}_records`, ["account_id", "code", "status_code", "amount", "quantity", "occurred_at"],
      Array.from({ length: rowsEach * 3 }, (_, i) => [
        (i % rowsEach) + 1,
        `${prefix}-R${i + 1}`,
        STATUSES[i % STATUSES.length],
        (i % 90) + 10,
        (i % 5) + 1,
        stamp(index * 200 + i),
      ])
    );
    await insertBatch(conn, `${prefix}_lines`, ["record_id", "sku", "quantity", "unit_amount", "line_total"],
      Array.from({ length: rowsEach * 3 }, (_, i) => {
        const quantity = (i % 3) + 1;
        const unit = (i % 25) + 4;
        return [i + 1, `SKU-${(i % 400) + 1000}`, quantity, unit, quantity * unit];
      })
    );
    await insertBatch(conn, `${prefix}_events`, ["record_id", "event_code", "notes", "occurred_at"],
      Array.from({ length: rowsEach }, (_, i) => [
        i * 3 + 1,
        ["created", "updated", "closed"][i % 3],
        `${prefix} event ${i + 1}`,
        stamp(index * 300 + i),
      ])
    );
  }
}

async function loadLedger(conn, count) {
  if (!count) return;
  const columns = ["customer_id", "product_id", "order_id", "amount", "quantity", "status_code", "booked_at"];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push([
      (i % 2000) + 1,
      (i % 400) + 1,
      (i % 5000) + 1,
      (i % 500) + 1,
      (i % 6) + 1,
      STATUSES[i % STATUSES.length],
      stamp(i),
    ]);
    if (rows.length === 2000) {
      await insertBatch(conn, "sales_ledger", columns, rows.splice(0, rows.length));
    }
  }
  if (rows.length) await insertBatch(conn, "sales_ledger", columns, rows);
}

async function adminConnection() {
  return mysql.createConnection({
    host: process.env.CATALOG_DB_HOST || "127.0.0.1",
    port: Number(process.env.CATALOG_DB_PORT || 3306),
    user: process.env.CATALOG_DB_USER,
    password: process.env.CATALOG_DB_PASSWORD,
    multipleStatements: false,
  });
}

async function recreateDatabase(admin, name) {
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(
    `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
}

async function ensureReadOnlyUser(admin, names) {
  for (const host of ["localhost", "127.0.0.1"]) {
    await admin.query(`DROP USER IF EXISTS '${USER}'@'${host}'`);
    await admin.query(
      `CREATE USER '${USER}'@'${host}' IDENTIFIED BY '${PASSWORD.replaceAll("'", "''")}'`
    );
    for (const name of names) {
      await admin.query(`GRANT SELECT ON \`${name}\`.* TO '${USER}'@'${host}'`);
    }
  }
  await admin.query("FLUSH PRIVILEGES");
}

async function measuredChars(database) {
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: Number(process.env.CATALOG_DB_PORT || 3306),
    user: USER,
    password: PASSWORD,
    database,
    multipleStatements: false,
  });
  try {
    await assertReadOnly(conn);
    const { getSchema } = await import("../src/index/schema.js");
    const schema = await getSchema(conn, database);
    const [counts] = await conn.query(
      `SELECT COUNT(*) AS tables_n FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [database]
    );
    const [rows] = await conn.query(
      `SELECT COALESCE(SUM(table_rows), 0) AS row_n
       FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [database]
    );
    return {
      chars: schemaToText(schema).length,
      tables: Number(counts[0].tables_n),
      rows: Number(rows[0].row_n),
    };
  } finally {
    await conn.end();
  }
}

async function seedDatabase(admin, spec, moduleCount) {
  await recreateDatabase(admin, spec.name);
  const conn = await mysql.createConnection({
    host: process.env.CATALOG_DB_HOST || "127.0.0.1",
    port: Number(process.env.CATALOG_DB_PORT || 3306),
    user: process.env.CATALOG_DB_USER,
    password: process.env.CATALOG_DB_PASSWORD,
    database: spec.name,
    multipleStatements: false,
  });
  try {
    const tables = buildTables(moduleCount, spec.ledgerRows > 0);
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const item of tables) await conn.query(createSql(item));
    await loadCore(conn);
    await loadModules(conn, moduleCount, spec.moduleRows);
    await loadLedger(conn, spec.ledgerRows);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
}

const plans = DATABASES.map((spec) => ({
  ...spec,
  modules: moduleCountFor(spec),
}));

const admin = await adminConnection();
try {
  for (const spec of plans) {
    console.log(`Building ${spec.name} (${spec.modules} generated modules)...`);
    await seedDatabase(admin, spec, spec.modules);
  }
  await ensureReadOnlyUser(admin, plans.map((spec) => spec.name));
} finally {
  await admin.end();
}

const results = [];
for (const spec of plans) {
  const measured = await measuredChars(spec.name);
  const path = choosePath(measured.chars);
  const plan = planForPath(path);
  if (measured.chars < spec.min || measured.chars > spec.max) {
    throw new Error(`${spec.name} measured ${measured.chars} characters, outside ${spec.min}-${spec.max}.`);
  }
  results.push({
    database: spec.name,
    tables: measured.tables,
    approxRows: measured.rows,
    schemaChars: measured.chars,
    path,
    plan: plan.code,
  });
}

console.log(JSON.stringify({
  host: "127.0.0.1",
  port: Number(process.env.CATALOG_DB_PORT || 3306),
  user: USER,
  password: PASSWORD,
  databases: results,
}, null, 2));
