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

function field(row, name) {
  return row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()];
}

export async function getSchema(connection, schemaName) {
  const [columns] = await connection.execute(
    `SELECT c.table_name, c.column_name, c.data_type, c.column_key
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema
      AND t.table_name = c.table_name
     WHERE c.table_schema = ?
       AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`,
    [schemaName]
  );

  const [foreignKeys] = await connection.execute(
    `SELECT table_name, column_name, referenced_table_name, referenced_column_name
     FROM information_schema.key_column_usage
     WHERE table_schema = ?
       AND referenced_table_name IS NOT NULL`,
    [schemaName]
  );

  const fkMap = new Map();
  for (const row of foreignKeys) {
    const table = field(row, "table_name");
    const column = field(row, "column_name");
    fkMap.set(
      `${table}.${column}`,
      `${field(row, "referenced_table_name")}.${field(row, "referenced_column_name")}`
    );
  }

  const schema = {};
  for (const col of columns) {
    const table = field(col, "table_name");
    if (SKIP_TABLES.has(String(table).toLowerCase())) continue;

    const column = field(col, "column_name");
    const entry = {
      column,
      type: field(col, "data_type"),
      key: field(col, "column_key"),
    };
    const references = fkMap.get(`${table}.${column}`);
    if (references) entry.references = references;

    if (!schema[table]) schema[table] = [];
    schema[table].push(entry);
  }

  return schema;
}

export function tableToText(tableName, cols, meta = null) {
  const columnText = cols
    .map((col) =>
      col.references ? `${col.column} (references ${col.references})` : col.column
    )
    .join(", ");

  const parts = [];
  if (meta?.module) parts.push(`Module: ${meta.module}.`);
  if (meta?.canonical === true) {
    parts.push("Canonical table for this business object.");
  }
  if (meta?.canonical === false) {
    parts.push("Not a canonical people/header table; prefer the module's main table.");
  }
  if (meta?.description) parts.push(meta.description);
  if (meta?.name_columns?.length) {
    parts.push(`Name/search columns: ${meta.name_columns.join(", ")}.`);
  }
  if (meta?.joins?.length) {
    parts.push(`Joins: ${meta.joins.map((join) => join.on).join("; ")}.`);
  }
  if (meta?.avoid?.length) {
    parts.push(`Do not confuse with: ${meta.avoid.join(", ")}.`);
  }
  parts.push(`Table: ${tableName}. Columns: ${columnText}`);
  return parts.join(" ");
}

export function schemaToText(schema, catalog = new Map()) {
  return Object.entries(schema)
    .map(([table, cols]) => {
      const meta = catalog.get(String(table).toLowerCase());
      const lines = [`Table: ${table}`];
      if (meta?.module) {
        lines.push(`  Module: ${meta.module}${meta.canonical ? " (canonical)" : ""}`);
      }
      if (meta?.description) lines.push(`  Description: ${meta.description}`);
      if (meta?.name_columns?.length) {
        lines.push(`  Name columns: ${meta.name_columns.join(", ")}`);
      }
      if (meta?.joins?.length) {
        lines.push(`  Joins: ${meta.joins.map((join) => join.on).join("; ")}`);
      }
      if (meta?.avoid?.length) {
        lines.push(`  Do not use: ${meta.avoid.join(", ")}`);
      }
      for (const col of cols || []) {
        let extra = "";
        if (col.key === "PRI") extra = ", primary key";
        else if (col.references) extra = `, foreign key -> ${col.references}`;
        lines.push(`  - ${col.column} (${col.type}${extra})`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export async function loadStoredSchema(catalog, workspaceId, connectionId, jsonCatalog) {
  const [tables] = await catalog.execute(
    `SELECT table_name, description, module, is_canonical
     FROM schema_tables
     WHERE workspace_id = ? AND connection_id = ?
     ORDER BY table_name`,
    [workspaceId, connectionId]
  );
  const [cols] = await catalog.execute(
    `SELECT st.table_name, sc.column_name, sc.data_type, sc.column_key, sc.references_col
     FROM schema_tables st
     JOIN schema_columns sc ON sc.table_id = st.id
     WHERE st.workspace_id = ? AND st.connection_id = ?
     ORDER BY st.table_name, sc.id`,
    [workspaceId, connectionId]
  );

  const schema = {};
  const metas = new Map();
  for (const table of tables) {
    const name = table.table_name;
    schema[name] = [];
    const json = jsonCatalog.get(String(name).toLowerCase()) || null;
    const canonical =
      table.is_canonical == null
        ? json?.canonical
        : Number(table.is_canonical) === 1;
    metas.set(String(name).toLowerCase(), {
      ...(json || {}),
      module: table.module || json?.module,
      description: table.description || json?.description,
      canonical,
    });
  }
  for (const col of cols) {
    if (!schema[col.table_name]) schema[col.table_name] = [];
    const entry = {
      column: col.column_name,
      type: col.data_type,
      key: col.column_key,
    };
    if (col.references_col) entry.references = col.references_col;
    schema[col.table_name].push(entry);
  }

  return {
    schema,
    metas,
    tableNames: Object.keys(schema),
    text: schemaToText(schema, metas),
  };
}
