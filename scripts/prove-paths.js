import "dotenv/config";
import mysql from "mysql2/promise";
import { randomBytes, randomUUID } from "node:crypto";
import { encryptSecret, decryptSecret } from "../src/db/crypto.js";
import { ensureCatalogTables } from "../src/db/migrate.js";
import { catalogConfig, createCatalogPool, ensureCatalogDatabase } from "../src/db/pool.js";
import { planForPath, TRIAL_DAYS, TRIAL_QUESTION_LIMIT, trialHasEnded } from "../src/billing/plans.js";
import {
  appendCompactTableNames,
  choosePath,
  MEDIUM_MAX_CHARS,
  SMALL_MAX_CHARS,
  answerQuestion,
} from "../src/engine/route.js";
import { resolveSqlProvider } from "../src/engine/models.js";
import { isSafeSelect, runReadOnlySelect, withLimit } from "../src/engine/sql.js";
import { loadFewshotExamples } from "../src/index/data/load.js";
import { ingestConnection } from "../src/index/ingest.js";
import { loadStoredSchema } from "../src/index/schema.js";
import { loadTableCatalog } from "../src/index/data/load.js";
import { assertReadOnly, grantsAreReadOnly } from "../src/index/readonly.js";
import { EMBEDDING_DIM } from "../src/index/embed.js";
import {
  createQdrantClient,
  ensureCollections,
  FEWSHOT_COLLECTION,
  SCHEMA_COLLECTION,
} from "../src/index/qdrant.js";
import { readFileSync } from "node:fs";

const PROOF_DB = "nlq_proof";
const PROOF_USER = "nlq_saas_ro";
const QUESTION = "How many orders have a paid status?";
const TABLE_CATALOG = loadTableCatalog();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unitChecks() {
  assert(choosePath(0) === "small", "0 chars is small");
  assert(choosePath(SMALL_MAX_CHARS) === "small", "30000 chars is small");
  assert(choosePath(SMALL_MAX_CHARS + 1) === "medium", "30001 chars is medium");
  assert(choosePath(MEDIUM_MAX_CHARS) === "medium", "120000 chars is medium");
  assert(choosePath(MEDIUM_MAX_CHARS + 1) === "large", "120001 chars is large");
  assert(planForPath("small").code === "starter", "small fits Starter");
  assert(planForPath("medium").code === "growth", "medium fits Growth");
  assert(planForPath("large").code === "scale", "large fits Scale");
  assert(planForPath("small").questionLimit === 150, "Starter question limit");
  assert(planForPath("medium").questionLimit === 400, "Growth question limit");
  assert(planForPath("large").questionLimit === 2000, "Scale question limit");
  assert(planForPath("large").connectionLimit === 3, "Scale connection limit");
  assert(TRIAL_QUESTION_LIMIT === 30, "trial question limit");
  assert(TRIAL_DAYS === 14, "trial lasts 14 days");
  const started = new Date("2026-01-01T00:00:00Z");
  assert(!trialHasEnded(started, new Date("2026-01-14T23:59:59Z")), "trial is open through day 14");
  assert(trialHasEnded(started, new Date("2026-01-15T00:00:00Z")), "trial ends after 14 days");

  assert(isSafeSelect("SELECT id FROM orders"), "select is allowed");
  assert(!isSafeSelect("SELECT id FROM orders; DELETE FROM orders"), "multi-statement blocked");
  assert(!isSafeSelect("DELETE FROM orders"), "delete blocked");
  assert(!isSafeSelect("INSERT INTO orders (id) VALUES (1)"), "insert blocked");
  assert(!isSafeSelect("UPDATE orders SET status_code = 'x'"), "update blocked");
  assert(!isSafeSelect("SELECT * FROM orders INTO OUTFILE '/tmp/x'"), "outfile blocked");
  assert(!isSafeSelect("/*!50000 INSERT INTO orders (id) VALUES (1) */"), "versioned insert blocked");
  assert(!isSafeSelect("WITH x AS (SELECT 1) DELETE FROM orders"), "cte delete blocked");
  assert(isSafeSelect("SELECT REPLACE(desk_name, '_', ' ') FROM customers"), "replace function allowed");
  assert(!isSafeSelect("SELECT id FROM orders FOR UPDATE"), "for update blocked");
  assert(!grantsAreReadOnly(["GRANT SELECT, INSERT ON `db`.* TO `u`@`localhost`"]), "insert grant rejected");
  assert(
    grantsAreReadOnly([
      "GRANT USAGE ON *.* TO `u`@`localhost`",
      "GRANT SELECT ON `db`.* TO `u`@`localhost`",
    ]),
    "select grant accepted"
  );
  const sqlModel = resolveSqlProvider();
  assert(sqlModel.id === "anthropic", "claude stays the default sql provider");
  assert(sqlModel.model === (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"), "claude model id");
  let unknownProvider = false;
  try {
    resolveSqlProvider("nope");
  } catch {
    unknownProvider = true;
  }
  assert(unknownProvider, "unknown sql provider rejected");
  if (!String(process.env.GEMINI_API_KEY || "").trim()) {
    let missingGemini = false;
    try {
      resolveSqlProvider("gemini");
    } catch (err) {
      missingGemini = /GEMINI_API_KEY/.test(err.message);
    }
    assert(missingGemini, "gemini without a key is rejected");
  }

  assert(withLimit("SELECT id FROM orders").endsWith("\nLIMIT 100"), "limit applied");
  assert(!/limit/i.test(withLimit("SELECT COUNT(*) FROM orders")), "count keeps no extra limit");

  const compact = appendCompactTableNames("Table: orders\n  - id (int)", ["zz_schema_pad"]);
  assert(compact.includes("Other tables (names only): zz_schema_pad"), "compact names");
  assert(!compact.includes("unsent_column_zz"), "compact list has no columns");

  const examples = loadFewshotExamples();
  assert(examples.length > 10, "ported few-shot examples load");
  const basicSource = readFileSync(new URL("../src/engine/basic.js", import.meta.url), "utf8");
  assert(!basicSource.includes("qdrant"), "full-schema engine does not reference qdrant");
  assert(!basicSource.includes("getEmbeddings"), "full-schema engine does not embed");
  console.log("unit checks passed");
}

function watchQdrant(client, bucket) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop !== "search") return value.bind(target);
      return async (...args) => {
        bucket.count += 1;
        bucket.filters.push(args[1]?.filter || null);
        return value.apply(target, args);
      };
    },
  });
}

function firstNumber(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  for (const value of Object.values(rows[0])) {
    const n = typeof value === "bigint" ? Number(value) : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function quotePassword(password) {
  return password.replaceAll("'", "''");
}

async function recreateProofDatabase(admin) {
  await admin.query(`DROP DATABASE IF EXISTS \`${PROOF_DB}\``);
  await admin.query(
    `CREATE DATABASE \`${PROOF_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await admin.query(`DROP USER IF EXISTS '${PROOF_USER}'@'localhost'`);
  const password = `Nlq${randomBytes(9).toString("hex")}@9`;
  try {
    await admin.query(
      `CREATE USER '${PROOF_USER}'@'localhost' IDENTIFIED BY '${quotePassword(password)}'`
    );
    await admin.query(
      `GRANT SELECT ON \`${PROOF_DB}\`.* TO '${PROOF_USER}'@'localhost'`
    );
  } catch (err) {
    throw new Error(`Could not create the read-only user (${err.code || "failed"}).`);
  }

  const db = await mysql.createConnection({
    host: process.env.CATALOG_DB_HOST || "127.0.0.1",
    port: Number(process.env.CATALOG_DB_PORT || 3306),
    user: process.env.CATALOG_DB_USER,
    password: process.env.CATALOG_DB_PASSWORD,
    database: PROOF_DB,
    multipleStatements: false,
  });
  try {
    await db.query(`
      CREATE TABLE customers (
        id INT NOT NULL PRIMARY KEY,
        desk_name VARCHAR(100) NOT NULL
      )
    `);
    await db.query(`
      CREATE TABLE order_status (
        status_code CHAR(1) NOT NULL PRIMARY KEY,
        description VARCHAR(40) NOT NULL
      )
    `);
    await db.query(`
      CREATE TABLE products (
        id INT NOT NULL PRIMARY KEY,
        sku VARCHAR(32) NOT NULL,
        product_name VARCHAR(100) NOT NULL
      )
    `);
    await db.query(`
      CREATE TABLE orders (
        id INT NOT NULL PRIMARY KEY,
        customer_id INT NOT NULL,
        status_code CHAR(1) NOT NULL,
        ordered_on DATE NOT NULL,
        CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
        CONSTRAINT fk_orders_status FOREIGN KEY (status_code) REFERENCES order_status (status_code)
      )
    `);
    await db.query(`
      CREATE TABLE order_items (
        id INT NOT NULL PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NOT NULL,
        qty INT NOT NULL,
        CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id),
        CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id)
      )
    `);
    await db.query(
      `INSERT INTO customers (id, desk_name) VALUES (1, 'North Desk'), (2, 'South Desk')`
    );
    await db.query(
      `INSERT INTO order_status (status_code, description) VALUES ('P', 'paid'), ('O', 'open'), ('S', 'shipped')`
    );
    await db.query(
      `INSERT INTO products (id, sku, product_name) VALUES (1, 'SKU-1', 'Lamp'), (2, 'SKU-2', 'Chair')`
    );
    await db.query(
      `INSERT INTO orders (id, customer_id, status_code, ordered_on) VALUES
        (1, 1, 'P', '2026-01-04'),
        (2, 2, 'P', '2026-01-05'),
        (3, 1, 'O', '2026-01-06')`
    );
    await db.query(
      `INSERT INTO order_items (id, order_id, product_id, qty) VALUES (1, 1, 1, 2), (2, 2, 2, 1)`
    );
  } finally {
    await db.end();
  }
  return password;
}

async function resetWorkspace(catalog, qdrant, name) {
  const [rows] = await catalog.execute(`SELECT id FROM workspaces WHERE name = ?`, [name]);
  for (const row of rows) {
    const workspaceId = Number(row.id);
    await catalog.execute(`DELETE FROM schema_lookup_values WHERE workspace_id = ?`, [workspaceId]);
    await catalog.execute(`DELETE FROM fewshot_examples WHERE workspace_id = ?`, [workspaceId]);
    await catalog.execute(`DELETE FROM usage_events WHERE workspace_id = ?`, [workspaceId]);
    for (const collection of [SCHEMA_COLLECTION, FEWSHOT_COLLECTION]) {
      await qdrant.delete(collection, {
        wait: true,
        filter: { must: [{ key: "workspace_id", match: { value: workspaceId } }] },
      });
    }
    await catalog.execute(`DELETE FROM workspaces WHERE id = ?`, [workspaceId]);
  }
}

async function setPad(catalog, workspaceId, connectionId, descriptionLength) {
  const description = `SCHEMA_PAD_MARKER ${"x".repeat(descriptionLength)}`;
  const [existing] = await catalog.execute(
    `SELECT id FROM schema_tables
     WHERE workspace_id = ? AND connection_id = ? AND table_name = 'zz_schema_pad'`,
    [workspaceId, connectionId]
  );
  let tableId;
  if (existing.length === 0) {
    const [inserted] = await catalog.execute(
      `INSERT INTO schema_tables
         (workspace_id, connection_id, table_name, description)
       VALUES (?, ?, 'zz_schema_pad', ?)`,
      [workspaceId, connectionId, description]
    );
    tableId = Number(inserted.insertId);
    await catalog.execute(
      `INSERT INTO schema_columns (table_id, column_name, data_type, column_key)
       VALUES (?, 'unsent_column_zz', 'varchar', NULL)`,
      [tableId]
    );
  } else {
    tableId = Number(existing[0].id);
    await catalog.execute(`UPDATE schema_tables SET description = ? WHERE id = ?`, [
      description,
      tableId,
    ]);
  }
  return tableId;
}

async function ask(ctx, password) {
  const logs = [];
  const prompts = [];
  const log = (line) => {
    logs.push(String(line));
    console.log(`  ${line}`);
  };
  const result = await answerQuestion(QUESTION, { ...ctx, onPrompt: (text) => prompts.push(text) }, log);
  const blob = logs.join("\n");
  assert(!blob.includes(password), "logs included the database password");
  assert(!JSON.stringify(result.rows || []).includes("North Desk"), "result logging leaked a row value");
  return {
    result,
    logs,
    prompt: prompts.at(-1) || "",
  };
}

function assertScoped(filters, workspaceId, connectionId) {
  assert(filters.length > 0, "expected vector searches to record a workspace filter");
  for (const filter of filters) {
    const must = filter?.must || [];
    assert(
      must.some((item) => item.key === "workspace_id" && item.match?.value === workspaceId),
      "vector search was not scoped by workspace"
    );
    assert(
      must.some((item) => item.key === "connection_id" && item.match?.value === connectionId),
      "vector search was not scoped by connection"
    );
  }
}

function report(label, result, searches) {
  console.log(
    `${label}: path=${result.path} plan=${result.plan.code} chars=${result.schema_text_chars} searches=${searches} rows=${result.rows?.length ?? 0} tokens=${result.estimated_tokens} sql=${result.executed_sql || result.executeError}`
  );
}

async function main() {
  unitChecks();
  await ensureCatalogDatabase();
  const catalog = createCatalogPool();
  const qdrant = createQdrantClient();
  const admin = await mysql.createConnection({
    host: catalogConfig().host,
    port: catalogConfig().port,
    user: catalogConfig().user,
    password: catalogConfig().password,
    multipleStatements: false,
  });
  let password = "";
  try {
    await ensureCatalogTables(catalog);
    await ensureCollections(qdrant);
    const [tables] = await catalog.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = ? AND table_name IN
         ('users', 'workspaces', 'connections', 'usage_events', 'schema_tables')`,
      [catalogConfig().database]
    );
    assert(tables.length === 5, "catalog tables were not created");

    password = await recreateProofDatabase(admin);
    const writer = await mysql.createConnection({
      host: catalogConfig().host,
      port: catalogConfig().port,
      user: catalogConfig().user,
      password: catalogConfig().password,
      database: PROOF_DB,
      multipleStatements: false,
    });
    try {
      let rejected = false;
      try {
        await assertReadOnly(writer);
      } catch (err) {
        rejected = err.message === "This MySQL user can write. Connect a read-only user.";
      }
      assert(rejected, "a writable MySQL user was accepted");
    } finally {
      await writer.end();
    }

    const writePool = mysql.createPool({
      host: catalogConfig().host,
      port: catalogConfig().port,
      user: catalogConfig().user,
      password: catalogConfig().password,
      database: PROOF_DB,
      connectionLimit: 2,
      multipleStatements: false,
    });
    try {
      let txnDenied = false;
      try {
        await runReadOnlySelect(
          writePool,
          `INSERT INTO customers (id, desk_name) VALUES (99, 'Blocked')`
        );
      } catch {
        txnDenied = true;
      }
      assert(txnDenied, "read-only transaction allowed an insert");
      const [leaked] = await writePool.query(
        `SELECT COUNT(*) AS n FROM customers WHERE id = 99`
      );
      assert(Number(leaked[0].n) === 0, "insert leaked through a read-only transaction");
    } finally {
      await writePool.end();
    }

    const source = {
      host: catalogConfig().host,
      port: catalogConfig().port,
      user: PROOF_USER,
      password,
      database: PROOF_DB,
    };
    const reader = await mysql.createConnection({
      ...source,
      multipleStatements: false,
    });
    try {
      await assertReadOnly(reader);
      let denied = false;
      try {
        await reader.query(`INSERT INTO customers (id, desk_name) VALUES (99, 'Blocked')`);
      } catch (err) {
        denied = err.errno === 1142 || err.errno === 1143;
      }
      assert(denied, "read-only user was able to insert");
      const [oracle] = await reader.query(
        `SELECT COUNT(*) AS n
         FROM orders o
         JOIN order_status s ON s.status_code = o.status_code
         WHERE s.description = 'paid'`
      );
      var expected = Number(oracle[0].n);
    } finally {
      await reader.end();
    }
    assert(expected === 2, "sample data did not load");

    const ciphertext = encryptSecret(password);
    assert(!ciphertext.includes(Buffer.from(password)), "ciphertext contained the password");
    assert(decryptSecret(ciphertext) === password, "password decrypt mismatch");

    await resetWorkspace(catalog, qdrant, "phase1-proof");
    await resetWorkspace(catalog, qdrant, "phase1-decoy");
    const [workspace] = await catalog.execute(
      `INSERT INTO workspaces (name, plan_code) VALUES ('phase1-proof', 'trial')`
    );
    const workspaceId = Number(workspace.insertId);
    const [connection] = await catalog.execute(
      `INSERT INTO connections
         (workspace_id, host, port, database_name, username, password_ciphertext)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [workspaceId, source.host, source.port, source.database, source.user, ciphertext]
    );
    const connectionId = Number(connection.insertId);
    const [storedCipher] = await catalog.execute(
      `SELECT password_ciphertext FROM connections WHERE id = ? AND workspace_id = ?`,
      [connectionId, workspaceId]
    );
    const fromDb = decryptSecret(storedCipher[0].password_ciphertext);
    assert(fromDb === password, "stored password did not decrypt");
    source.password = fromDb;

    await ensureCollections(qdrant);
    await catalog.execute(
      `INSERT INTO fewshot_examples
         (workspace_id, connection_id, question, sql_text, explanation)
       VALUES (?, ?, 'leftover demo', 'SELECT id FROM eps_proposal', 'agreement leftover')`,
      [workspaceId, connectionId]
    );
    await catalog.execute(
      `INSERT INTO fewshot_examples
         (workspace_id, connection_id, question, sql_text, explanation)
       VALUES (?, 0, 'other connection demo', 'SELECT id FROM agreement', 'proposal leftover')`,
      [workspaceId]
    );
    await qdrant.upsert(FEWSHOT_COLLECTION, {
      wait: true,
      points: [
        {
          id: randomUUID(),
          vector: Array.from({ length: EMBEDDING_DIM }, (_, index) => (index === 0 ? 1 : 0)),
          payload: {
            workspace_id: workspaceId,
            connection_id: 0,
            question: "leftover demo",
            sql: "SELECT id FROM eps_proposal",
            explanation: "agreement leftover",
          },
        },
      ],
    });

    const indexed = await ingestConnection({
      catalog,
      qdrant,
      workspaceId,
      connectionId,
      source,
      onProgress: (event) => console.log(`index: ${event.message}`),
    });
    const [exampleRows] = await catalog.execute(
      `SELECT COUNT(*) AS n FROM fewshot_examples WHERE workspace_id = ?`,
      [workspaceId]
    );
    const exampleCount = Number(exampleRows[0].n);
    const leftoverExamples = await qdrant.scroll(FEWSHOT_COLLECTION, {
      filter: { must: [{ key: "workspace_id", match: { value: workspaceId } }] },
      limit: 10,
      with_payload: false,
    });
    assert(exampleCount === 0, "ingest stored example rows");
    assert((leftoverExamples.points || []).length === 0, "ingest left example vectors");
    console.log(
      `indexed tables=${indexed.tableCount} lookups=${indexed.lookupCount} examples=${exampleCount} chars=${indexed.schemaTextChars}`
    );
    assert(indexed.schemaTextChars <= SMALL_MAX_CHARS, "sample schema was not small");
    assert(indexed.schemaTextChars > 0, "schema text was empty");
    assert(indexed.lookupCount >= 3, "lookup values were not indexed");

    const [decoyWorkspace] = await catalog.execute(
      `INSERT INTO workspaces (name, plan_code) VALUES ('phase1-decoy', 'trial')`
    );
    const decoyWorkspaceId = Number(decoyWorkspace.insertId);
    await catalog.execute(
      `INSERT INTO schema_lookup_values
         (workspace_id, connection_id, table_name, column_name, value_text)
       VALUES (?, 0, 'secret_table', 'secret_col', 'paid')`,
      [decoyWorkspaceId]
    );
    const scrolled = await qdrant.scroll(SCHEMA_COLLECTION, {
      filter: {
        must: [
          { key: "workspace_id", match: { value: workspaceId } },
          { key: "connection_id", match: { value: connectionId } },
        ],
      },
      limit: 1,
      with_vector: true,
      with_payload: true,
    });
    const donor = scrolled.points?.[0];
    assert(donor?.vector, "schema index has no vector to use as a scope check");
    await qdrant.upsert(SCHEMA_COLLECTION, {
      wait: true,
      points: [
        {
          id: randomUUID(),
          vector: donor.vector,
          payload: {
            workspace_id: decoyWorkspaceId,
            connection_id: 0,
            table_id: 0,
            table_name: "secret_table",
          },
        },
      ],
    });

    const searches = { count: 0, filters: [] };
    const ctx = {
      workspaceId,
      connectionId,
      catalog,
      qdrant: watchQdrant(qdrant, searches),
      source,
    };

    searches.count = 0;
    const small = await ask(ctx, password);
    report("small", small.result, searches.count);
    assert(small.result.path === "small", `expected small, got ${small.result.path}`);
    assert(small.result.plan.code === "starter", "small schema did not fit Starter");
    assert(searches.count === 0, "small path ran vector search");
    assert(!small.logs.some((line) => line.includes("searching table index")), "small path searched");
    assert(small.prompt.includes("product_name"), "small prompt missed a real column");
    assert(small.prompt.includes("Table: orders"), "small prompt missed a real table");
    assert(!small.prompt.includes("Other tables (names only)"), "small prompt used the compact list");
    assert(!small.prompt.includes("secret_table"), "small prompt leaked another workspace");
    assert(small.result.executeError == null, small.result.executeError || "small SQL failed");
    assert(firstNumber(small.result.rows) === expected, "small path returned the wrong count");
    assert(small.result.estimated_tokens > 0, "small path did not record tokens");

    await setPad(catalog, workspaceId, connectionId, 45000);
    let stored = await loadStoredSchema(catalog, workspaceId, connectionId, TABLE_CATALOG);
    assert(
      stored.text.length > SMALL_MAX_CHARS && stored.text.length <= MEDIUM_MAX_CHARS,
      `padded medium length was ${stored.text.length}`
    );

    searches.count = 0;
    searches.filters = [];
    const medium = await ask(ctx, password);
    report("medium", medium.result, searches.count);
    assert(medium.result.path === "medium", `expected medium, got ${medium.result.path}`);
    assert(medium.result.plan.code === "growth", "medium schema did not fit Growth");
    assert(searches.count > 0, "medium path skipped vector search");
    assert(medium.prompt.includes("Other tables (names only):"), "medium prompt missed table names");
    assert(medium.prompt.includes("zz_schema_pad"), "medium prompt missed the other table name");
    assert(!medium.prompt.includes("SCHEMA_PAD_MARKER"), "medium prompt included padded schema text");
    assert(!medium.prompt.includes("unsent_column_zz"), "medium prompt included an unretrieved column");
    assert(!medium.prompt.includes("secret_table"), "medium path leaked another workspace");
    assert(!medium.result.term_links.includes("secret_table"), "lookup match leaked another workspace");
    assert(medium.result.executeError == null, medium.result.executeError || "medium SQL failed");
    assert(firstNumber(medium.result.rows) === expected, "medium path returned the wrong count");
    assert(medium.result.estimated_tokens > 0, "medium path did not record tokens");
    assertScoped(searches.filters, workspaceId, connectionId);

    await setPad(catalog, workspaceId, connectionId, 130000);
    stored = await loadStoredSchema(catalog, workspaceId, connectionId, TABLE_CATALOG);
    assert(stored.text.length > MEDIUM_MAX_CHARS, `padded large length was ${stored.text.length}`);

    searches.count = 0;
    searches.filters = [];
    const large = await ask(ctx, password);
    report("large", large.result, searches.count);
    assert(large.result.path === "large", `expected large, got ${large.result.path}`);
    assert(large.result.plan.code === "scale", "large schema did not fit Scale");
    assert(searches.count > 0, "large path skipped vector search");
    assert(!large.prompt.includes("Other tables (names only)"), "large prompt included the compact list");
    assert(!large.prompt.includes("SCHEMA_PAD_MARKER"), "large prompt included padded schema text");
    assert(!large.prompt.includes("unsent_column_zz"), "large prompt included an unretrieved column");
    assert(!large.prompt.includes("secret_table"), "large path leaked another workspace");
    assert(large.prompt.includes("description"), "large prompt missed retrieved columns");
    assert(large.result.executeError == null, large.result.executeError || "large SQL failed");
    assert(firstNumber(large.result.rows) === expected, "large path returned the wrong count");
    assert(large.result.estimated_tokens > 0, "large path did not record tokens");
    assert(large.result.fewshots.length === 0, "large path retrieved stored examples");
    assertScoped(searches.filters, workspaceId, connectionId);

    console.log("phase 1 paths passed");
  } finally {
    await admin.end();
    await catalog.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
