import mysql from "mysql2/promise";

export function catalogConfig() {
  const database = process.env.CATALOG_DB_NAME || "nlp_saas";
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error("CATALOG_DB_NAME must contain only letters, digits, and underscores.");
  }
  return {
    host: process.env.CATALOG_DB_HOST || "127.0.0.1",
    port: Number(process.env.CATALOG_DB_PORT || 3306),
    user: process.env.CATALOG_DB_USER,
    password: process.env.CATALOG_DB_PASSWORD,
    database,
    connectionLimit: 4,
    multipleStatements: false,
  };
}

export function createCatalogPool() {
  return mysql.createPool(catalogConfig());
}

export async function ensureCatalogDatabase() {
  const cfg = catalogConfig();
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    multipleStatements: false,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conn.end();
  }
}
