const VALUE_LIMIT = 400;
const MAX_VALUE_LENGTH = 160;
const SKIP_TABLES = new Set([
  "schema_tables",
  "schema_columns",
  "schema_lookup_values",
  "fewshot_examples",
  "users",
  "workspaces",
  "connections",
  "usage_events",
]);
const rebuilds = new Map();

function field(row, name) {
  return row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()];
}

function quoteIdent(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `\`${name}\``;
}

function likePattern(stem) {
  return `%${String(stem).replace(/[\\%_]/g, "\\$&")}%`;
}

export function stemWord(word) {
  if (word.length > 5 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

export async function rebuildLookupValues(catalog, source, scope, log = () => {}) {
  const { workspaceId, connectionId, database } = scope;
  await catalog.execute(
    `DELETE FROM schema_lookup_values WHERE workspace_id = ? AND connection_id = ?`,
    [workspaceId, connectionId]
  );

  const [columns] = await source.execute(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS c
     JOIN information_schema.TABLES t
       ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
      AND t.TABLE_NAME = c.TABLE_NAME
     WHERE c.TABLE_SCHEMA = ?
       AND t.TABLE_TYPE = 'BASE TABLE'
       AND c.DATA_TYPE IN ('varchar', 'char')
       AND c.CHARACTER_MAXIMUM_LENGTH BETWEEN 1 AND 200
       AND LOWER(c.COLUMN_NAME) IN ('description', 'desc', 'keyword', 'label')
       AND (
         (IFNULL(t.TABLE_ROWS, 0) > 0 AND t.TABLE_ROWS <= 5000)
         OR (IFNULL(t.TABLE_ROWS, 0) = 0 AND IFNULL(t.DATA_LENGTH, 0) < 2000000)
       )`,
    [database]
  );

  const rows = [];
  let scanned = 0;
  for (const col of columns) {
    const table = field(col, "table_name");
    const column = field(col, "column_name");
    if (SKIP_TABLES.has(String(table).toLowerCase())) continue;
    scanned += 1;
    const sql = `SELECT DISTINCT ${quoteIdent(column)} AS value_text
      FROM ${quoteIdent(database)}.${quoteIdent(table)}
      WHERE ${quoteIdent(column)} IS NOT NULL
        AND ${quoteIdent(column)} <> ''
      LIMIT ${VALUE_LIMIT}`;
    let values;
    try {
      const [found] = await source.query(sql);
      values = found;
    } catch (err) {
      log(`Skipped lookup column ${table}.${column}: ${err.message}`);
      continue;
    }
    for (const row of values) {
      const value = String(field(row, "value_text") ?? "").trim();
      if (!value || value.length > MAX_VALUE_LENGTH) continue;
      if (/^[\d\s.-]+$/.test(value)) continue;
      rows.push([workspaceId, connectionId, table, column, value]);
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await catalog.query(
      `INSERT INTO schema_lookup_values
         (workspace_id, connection_id, table_name, column_name, value_text)
       VALUES ?`,
      [batch]
    );
  }
  log(`Indexed ${rows.length} lookup values from ${scanned} columns`);
  return rows.length;
}

export async function ensureLookupValues(catalog, source, scope) {
  const { workspaceId, connectionId } = scope;
  const [counts] = await catalog.execute(
    `SELECT COUNT(*) AS n
     FROM schema_lookup_values
     WHERE workspace_id = ? AND connection_id = ?`,
    [workspaceId, connectionId]
  );
  if (Number(counts[0].n) > 0) return;

  const key = `${workspaceId}:${connectionId}`;
  if (!rebuilds.has(key)) {
    const pending = rebuildLookupValues(catalog, source, scope).finally(() => {
      rebuilds.delete(key);
    });
    rebuilds.set(key, pending);
  }
  await rebuilds.get(key);
}

export async function matchLookupTerms(catalog, tokens, scope) {
  const stems = [...new Set(tokens.map(stemWord))].filter((stem) => stem.length >= 3);
  if (stems.length === 0) return [];

  const clauses = stems.map(() => "LOWER(value_text) LIKE ?").join(" OR ");
  const params = [
    scope.workspaceId,
    scope.connectionId,
    ...stems.map((stem) => likePattern(stem)),
  ];
  const [rows] = await catalog.execute(
    `SELECT table_name, column_name, value_text
     FROM schema_lookup_values
     WHERE workspace_id = ? AND connection_id = ? AND (${clauses})`,
    params
  );

  const matches = [];
  for (const token of tokens) {
    const stem = stemWord(token);
    const pattern = new RegExp(`\\b${stem}(?:es|s)?\\b`, "i");
    const hits = rows.filter((row) => pattern.test(String(field(row, "value_text"))));
    if (hits.length === 0) continue;
    for (const row of hits) {
      matches.push({
        token,
        table_name: field(row, "table_name"),
        column_name: field(row, "column_name"),
        value: String(field(row, "value_text"))
          .replace(/[\r\n]+/g, " ")
          .slice(0, MAX_VALUE_LENGTH),
      });
    }
  }
  return matches;
}
