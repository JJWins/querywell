import mysql from "mysql2/promise";

function ident(name, label) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name || ""))) {
    throw new Error(`Unsafe ${label}.`);
  }
  return String(name);
}

export function sourceConfig(config) {
  return {
    host: config.host,
    port: Number(config.port || 3306),
    user: config.user,
    password: config.password,
    database: ident(config.database, "database name"),
    connectionLimit: 2,
    connectTimeout: 10000,
    multipleStatements: false,
  };
}

export function openSourcePool(config) {
  return mysql.createPool(sourceConfig(config));
}

export function assertEngineContext(ctx) {
  if (!ctx?.workspaceId) throw new Error("workspaceId is required.");
  if (!ctx?.connectionId) throw new Error("connectionId is required.");
  if (!ctx?.catalog) throw new Error("catalog pool is required.");
  if (!ctx?.source?.host || !ctx?.source?.user || !ctx?.source?.database) {
    throw new Error("source connection config is required.");
  }
  if (!Object.prototype.hasOwnProperty.call(ctx.source, "password")) {
    throw new Error("source connection config is required.");
  }
}
