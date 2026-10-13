import { encryptSecret } from "../db/crypto.js";
import { openSourcePool, sourceConfig } from "../db/source.js";
import { choosePath } from "../engine/route.js";
import { planForPath } from "../billing/plans.js";
import { ingestConnection } from "../index/ingest.js";
import { assertReadOnly } from "../index/readonly.js";
import { HttpError } from "./errors.js";

const running = new Set();

export function fittingPlan(schemaTextChars) {
  const chars = Number(schemaTextChars);
  if (!Number.isFinite(chars) || chars <= 0) return null;
  const path = choosePath(chars);
  const plan = planForPath(path);
  return {
    schemaTextChars: chars,
    path,
    plan: {
      code: plan.code,
      monthlyUsd: plan.monthlyUsd,
      questionLimit: plan.questionLimit,
    },
  };
}

function parseSource(body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be JSON.");
  }
  const host = String(body.host || "").trim();
  const database = String(body.database || "").trim();
  const username = String(body.username || "").trim();
  const password = body.password == null ? "" : String(body.password);
  const port = body.port == null || body.port === "" ? 3306 : Number(body.port);
  if (!host || host.length > 255 || !/^[\w.-]+$/.test(host)) {
    throw new HttpError(400, "Enter the MySQL host.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, "Enter a valid MySQL port.");
  }
  if (!username || username.length > 255 || /[\u0000-\u001f]/.test(username)) {
    throw new HttpError(400, "Enter the MySQL username.");
  }
  if (!password || password.length > 200) {
    throw new HttpError(400, "Enter the MySQL password.");
  }
  try {
    return sourceConfig({ host, port, user: username, password, database });
  } catch {
    throw new HttpError(400, "Enter a database name made of letters, digits, and underscores.");
  }
}

function connectionError(err) {
  if (err instanceof HttpError) return err;
  if (err?.code === "ECONNREFUSED" || err?.code === "ENOTFOUND" || err?.code === "ETIMEDOUT") {
    return new HttpError(400, "Could not connect to that MySQL database.");
  }
  if (err?.code === "ER_ACCESS_DENIED_ERROR") {
    return new HttpError(400, "MySQL rejected that username or password.");
  }
  if (
    err?.message === "This MySQL user can write. Connect a read-only user." ||
    err?.message === "Could not verify that the MySQL user is read-only."
  ) {
    return new HttpError(400, err.message);
  }
  return new HttpError(400, "Could not connect to that MySQL database.");
}

function safeMessage(err, secret) {
  const message = String(err?.message || "Could not index that database.");
  if (secret && message.includes(secret)) return "Could not index that database.";
  if (message.length > 400) return "Could not index that database.";
  return message;
}

async function probeReadOnly(source) {
  const pool = openSourcePool(source);
  try {
    let connection;
    try {
      connection = await pool.getConnection();
    } catch (err) {
      throw connectionError(err);
    }
    try {
      await assertReadOnly(connection);
    } catch (err) {
      throw connectionError(err);
    } finally {
      connection.release();
    }
  } finally {
    await pool.end();
  }
}

async function saveConnection(catalog, workspaceId, source, ciphertext) {
  const [rows] = await catalog.execute(
    `SELECT id FROM connections WHERE workspace_id = ? ORDER BY id`,
    [workspaceId]
  );
  if (rows.length === 0) {
    const [result] = await catalog.execute(
      `INSERT INTO connections
         (workspace_id, host, port, database_name, username, password_ciphertext)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [workspaceId, source.host, source.port, source.database, source.user, ciphertext]
    );
    return Number(result.insertId);
  }

  const connectionId = Number(rows[0].id);
  await catalog.execute(
    `UPDATE connections
       SET host = ?, port = ?, database_name = ?, username = ?, password_ciphertext = ?
     WHERE id = ? AND workspace_id = ?`,
    [source.host, source.port, source.database, source.user, ciphertext, connectionId, workspaceId]
  );

  const extra = rows.slice(1).map((row) => Number(row.id));
  if (extra.length > 0) {
    const placeholders = extra.map(() => "?").join(",");
    await catalog.execute(
      `DELETE FROM schema_lookup_values WHERE workspace_id = ? AND connection_id IN (${placeholders})`,
      [workspaceId, ...extra]
    );
    await catalog.execute(
      `DELETE FROM connections WHERE workspace_id = ? AND id IN (${placeholders})`,
      [workspaceId, ...extra]
    );
  }
  return connectionId;
}

export async function readConnection(catalog, workspaceId) {
  const [rows] = await catalog.execute(
    `SELECT host, port, database_name, username, schema_text_chars
     FROM connections
     WHERE workspace_id = ?
     ORDER BY id
     LIMIT 1`,
    [workspaceId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const connection = {
    host: row.host,
    port: Number(row.port),
    database: row.database_name,
    username: row.username,
    schemaTextChars: Number(row.schema_text_chars) || 0,
  };
  const fit = fittingPlan(connection.schemaTextChars);
  if (fit) {
    connection.path = fit.path;
    connection.plan = fit.plan;
  }
  return connection;
}

export async function indexConnection({ catalog, qdrant, workspaceId, body, onEvent }) {
  const source = parseSource(body);
  if (running.has(workspaceId)) {
    throw new HttpError(409, "Indexing is already running for this workspace.");
  }
  running.add(workspaceId);
  try {
    onEvent({ step: "access", state: "active", detail: "Checking grants" });
    await probeReadOnly(source);
    onEvent({ step: "access", state: "done", detail: "SELECT only" });
    const ciphertext = encryptSecret(source.password);
    const connectionId = await saveConnection(catalog, workspaceId, source, ciphertext);
    let indexed;
    try {
      indexed = await ingestConnection({
        catalog,
        qdrant,
        workspaceId,
        connectionId,
        source,
        onProgress(event) {
          onEvent(event);
        },
      });
    } catch (err) {
      onEvent({ step: "error", message: safeMessage(err, source.password) });
      return;
    }
    const fit = fittingPlan(indexed.schemaTextChars);
    if (!fit) {
      onEvent({ step: "error", message: "Schema text length was not recorded." });
      return;
    }
    onEvent({
      step: "done",
      message: `Schema text is ${fit.schemaTextChars} characters`,
      schemaTextChars: fit.schemaTextChars,
      path: fit.path,
      plan: fit.plan,
    });
  } finally {
    running.delete(workspaceId);
  }
}
