async function addColumnIfMissing(pool, table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length > 0) return;
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}

export async function ensureCatalogTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT NOT NULL AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      token_hash VARBINARY(32) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_sessions_token (token_hash),
      KEY user_id (user_id),
      CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id BIGINT NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      owner_user_id BIGINT NULL,
      plan_code VARCHAR(32) NOT NULL DEFAULT 'trial',
      schema_text_chars INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY owner_user_id (owner_user_id)
    )
  `);

  await addColumnIfMissing(
    pool,
    "workspaces",
    "stripe_customer_id",
    "stripe_customer_id VARCHAR(255) NULL"
  );
  await addColumnIfMissing(
    pool,
    "workspaces",
    "stripe_subscription_id",
    "stripe_subscription_id VARCHAR(255) NULL"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id BIGINT NOT NULL AUTO_INCREMENT,
      workspace_id BIGINT NOT NULL,
      host VARCHAR(255) NOT NULL,
      port INT NOT NULL DEFAULT 3306,
      database_name VARCHAR(255) NOT NULL,
      username VARCHAR(255) NOT NULL,
      password_ciphertext VARBINARY(2048) NOT NULL,
      schema_text_chars INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY workspace_id (workspace_id),
      CONSTRAINT fk_connections_workspace
        FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_tables (
      id BIGINT NOT NULL AUTO_INCREMENT,
      workspace_id BIGINT NOT NULL,
      connection_id BIGINT NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      description MEDIUMTEXT,
      module VARCHAR(64) DEFAULT NULL,
      is_canonical TINYINT DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ws_conn_table (workspace_id, connection_id, table_name),
      KEY connection_id (connection_id),
      CONSTRAINT fk_schema_tables_connection
        FOREIGN KEY (connection_id) REFERENCES connections (id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_columns (
      id BIGINT NOT NULL AUTO_INCREMENT,
      table_id BIGINT NOT NULL,
      column_name VARCHAR(255) NOT NULL,
      data_type VARCHAR(64) DEFAULT NULL,
      column_key VARCHAR(16) DEFAULT NULL,
      references_col VARCHAR(255) DEFAULT NULL,
      PRIMARY KEY (id),
      KEY table_id (table_id),
      CONSTRAINT fk_schema_columns_table
        FOREIGN KEY (table_id) REFERENCES schema_tables (id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_lookup_values (
      id BIGINT NOT NULL AUTO_INCREMENT,
      workspace_id BIGINT NOT NULL,
      connection_id BIGINT NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      column_name VARCHAR(255) NOT NULL,
      value_text VARCHAR(255) NOT NULL,
      PRIMARY KEY (id),
      KEY ws_conn_table (workspace_id, connection_id, table_name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fewshot_examples (
      id BIGINT NOT NULL AUTO_INCREMENT,
      workspace_id BIGINT NOT NULL,
      connection_id BIGINT NOT NULL,
      question TEXT NOT NULL,
      sql_text TEXT,
      explanation TEXT,
      PRIMARY KEY (id),
      KEY ws_conn (workspace_id, connection_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id BIGINT NOT NULL AUTO_INCREMENT,
      workspace_id BIGINT NOT NULL,
      name VARCHAR(80) NOT NULL,
      key_hash VARBINARY(32) NOT NULL,
      key_prefix VARCHAR(32) NOT NULL,
      last_used_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_api_keys_hash (key_hash),
      KEY workspace_id (workspace_id),
      CONSTRAINT fk_api_keys_workspace
        FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id BIGINT NOT NULL AUTO_INCREMENT,
      workspace_id BIGINT NOT NULL,
      connection_id BIGINT NULL,
      asked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      path_code VARCHAR(16) NOT NULL,
      estimated_tokens INT NOT NULL DEFAULT 0,
      success TINYINT NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY ws_month (workspace_id, asked_at)
    )
  `);
}
