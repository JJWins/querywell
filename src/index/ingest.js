import { randomUUID } from "node:crypto";
import { loadTableCatalog, lookupCatalog } from "./data/load.js";
import { getEmbedding } from "./embed.js";
import { rebuildLookupValues } from "./lookup.js";
import { ensureCollections, FEWSHOT_COLLECTION, SCHEMA_COLLECTION } from "./qdrant.js";
import { assertReadOnly } from "./readonly.js";
import { getSchema, loadStoredSchema, tableToText } from "./schema.js";
import { openSourcePool } from "../db/source.js";

const EMBED_CONCURRENCY = Number(process.env.EMBED_CONCURRENCY || 8);
const UPSERT_BATCH_SIZE = 64;
const COLUMN_INSERT_BATCH = 500;
const TABLE_CATALOG = loadTableCatalog();

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function clearConnection(catalog, qdrant, workspaceId, connectionId) {
  await catalog.execute(
    `DELETE FROM schema_lookup_values WHERE workspace_id = ? AND connection_id = ?`,
    [workspaceId, connectionId]
  );
  await catalog.execute(`DELETE FROM fewshot_examples WHERE workspace_id = ?`, [workspaceId]);
  await catalog.execute(
    `DELETE FROM schema_tables WHERE workspace_id = ? AND connection_id = ?`,
    [workspaceId, connectionId]
  );

  const schemaFilter = {
    must: [
      { key: "workspace_id", match: { value: Number(workspaceId) } },
      { key: "connection_id", match: { value: Number(connectionId) } },
    ],
  };
  await qdrant.delete(SCHEMA_COLLECTION, { wait: true, filter: schemaFilter });
  await qdrant.delete(FEWSHOT_COLLECTION, {
    wait: true,
    filter: {
      must: [{ key: "workspace_id", match: { value: Number(workspaceId) } }],
    },
  });
}

async function insertColumns(catalog, rows) {
  for (let i = 0; i < rows.length; i += COLUMN_INSERT_BATCH) {
    const batch = rows.slice(i, i + COLUMN_INSERT_BATCH);
    await catalog.query(
      `INSERT INTO schema_columns
         (table_id, column_name, data_type, column_key, references_col)
       VALUES ?`,
      [batch]
    );
  }
}

async function recordSchemaChars(catalog, workspaceId, connectionId) {
  const stored = await loadStoredSchema(
    catalog,
    workspaceId,
    connectionId,
    TABLE_CATALOG
  );
  const chars = stored.text.length;
  await catalog.execute(
    `UPDATE connections SET schema_text_chars = ? WHERE id = ? AND workspace_id = ?`,
    [chars, connectionId, workspaceId]
  );
  await catalog.execute(
    `UPDATE workspaces SET schema_text_chars = ? WHERE id = ?`,
    [chars, workspaceId]
  );
  return stored;
}

export async function ingestConnection({
  catalog,
  qdrant,
  workspaceId,
  connectionId,
  source,
  onProgress = () => {},
}) {
  await ensureCollections(qdrant);
  const sourcePool = openSourcePool(source);
  try {
    const probe = await sourcePool.getConnection();
    try {
      await assertReadOnly(probe);
    } finally {
      probe.release();
    }

    onProgress({ step: "schema", state: "active", detail: "Reading information_schema" });
    const schema = await getSchema(sourcePool, source.database);
    const tableCount = Object.keys(schema).length;
    if (tableCount === 0) {
      throw new Error(`No base tables found in ${source.database}.`);
    }
    onProgress({ step: "schema", state: "done", detail: `${tableCount} tables` });

    await clearConnection(catalog, qdrant, workspaceId, connectionId);

    onProgress({ step: "catalog", state: "active", detail: "Saving tables and columns" });
    const columnRows = [];
    const points = [];
    for (const [tableName, cols] of Object.entries(schema)) {
      const meta = lookupCatalog(TABLE_CATALOG, tableName);
      const [tableResult] = await catalog.execute(
        `INSERT INTO schema_tables
           (workspace_id, connection_id, table_name, description, module, is_canonical)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          connectionId,
          tableName,
          meta?.description ?? null,
          meta?.module ?? null,
          meta?.canonical == null ? null : meta.canonical ? 1 : 0,
        ]
      );
      const tableId = Number(tableResult.insertId);
      for (const col of cols) {
        columnRows.push([
          tableId,
          col.column,
          col.type,
          col.key || null,
          col.references ?? null,
        ]);
      }
      points.push({
        tableId,
        tableName,
        text: tableToText(tableName, cols, meta),
      });
    }
    await insertColumns(catalog, columnRows);
    onProgress({
      step: "catalog",
      state: "done",
      detail: `${tableCount} tables, ${columnRows.length} columns`,
    });

    onProgress({ step: "embed", state: "active", detail: `0 of ${points.length} tables` });
    let embedded = 0;
    const vectors = await mapPool(points, EMBED_CONCURRENCY, async (point) => {
      const vector = await getEmbedding(point.text);
      embedded += 1;
      if (embedded % 25 === 0 || embedded === points.length) {
        onProgress({
          step: "embed",
          state: "active",
          detail: `${embedded} of ${points.length} tables`,
        });
      }
      return vector;
    });
    onProgress({ step: "embed", state: "done", detail: `${points.length} tables` });

    onProgress({ step: "vectors", state: "active", detail: "Writing the table index" });
    for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
      const batch = points.slice(i, i + UPSERT_BATCH_SIZE).map((point, offset) => ({
        id: randomUUID(),
        vector: vectors[i + offset],
        payload: {
          workspace_id: Number(workspaceId),
          connection_id: Number(connectionId),
          table_id: point.tableId,
          table_name: point.tableName,
        },
      }));
      await qdrant.upsert(SCHEMA_COLLECTION, { wait: true, points: batch });
    }
    onProgress({ step: "vectors", state: "done", detail: `${points.length} vectors` });

    onProgress({ step: "lookups", state: "active", detail: "Scanning short text columns" });
    const lookupCount = await rebuildLookupValues(
      catalog,
      sourcePool,
      {
        workspaceId,
        connectionId,
        database: source.database,
      }
    );
    const lookupLabel = lookupCount === 1 ? "1 value" : `${lookupCount} values`;
    onProgress({ step: "lookups", state: "done", detail: lookupLabel });

    onProgress({ step: "measure", state: "active", detail: "Counting schema text" });
    const stored = await recordSchemaChars(catalog, workspaceId, connectionId);
    onProgress({
      step: "measure",
      state: "done",
      detail: `${stored.text.length.toLocaleString("en-US")} characters`,
    });

    return {
      tableCount,
      columnCount: columnRows.length,
      lookupCount,
      schemaTextChars: stored.text.length,
    };
  } finally {
    await sourcePool.end();
  }
}
