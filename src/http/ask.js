import { questionLimitForPlan, trialEndsAt, trialHasEnded } from "../billing/plans.js";
import { decryptSecret } from "../db/crypto.js";
import { sourceConfig } from "../db/source.js";
import { resolveSqlProvider } from "../engine/models.js";
import { answerQuestion } from "../engine/route.js";
import { HttpError } from "./errors.js";

function plain(value) {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value;
}

function plainRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) out[key] = plain(value);
    return out;
  });
}

function retrievedNames(tables) {
  const names = [];
  const seen = new Set();
  for (const hit of tables || []) {
    const name = typeof hit === "string" ? hit : hit?.table_name;
    const label = String(name || "");
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    names.push(label);
  }
  return names;
}

export function answerSummary(result) {
  if (result.path === "small") {
    return {
      kind: "full",
      tableCount: Array.isArray(result.included_tables) ? result.included_tables.length : 0,
      schemaTextChars: result.schema_text_chars,
    };
  }
  return {
    kind: "retrieved",
    tables: retrievedNames(result.tables),
  };
}

function publicError(err, secret) {
  const message = String(err?.message || "Could not answer that question.");
  if (secret && message.includes(secret)) return "Could not answer that question.";
  if (message.length > 400) return "Could not answer that question.";
  return message;
}

export function quotaMessage(used, limit) {
  return `This workspace has used ${used} of ${limit} questions this month.`;
}

export function prefersJson(acceptHeader) {
  const accept = String(acceptHeader || "").toLowerCase();
  if (accept.includes("application/x-ndjson")) return false;
  return accept.includes("application/json");
}

export function askJsonBody(question, done) {
  const rows = Array.isArray(done.rows) ? done.rows : [];
  return {
    question,
    sql: done.sql,
    columns: rows[0] ? Object.keys(rows[0]) : [],
    rows,
    explanation: done.explanation || "",
    provider: done.provider || null,
    model: done.model || null,
    telemetry: {
      schema_ms: Number(done.schemaMs) || 0,
      synthesis_ms: Number(done.synthesisMs) || 0,
      execution_ms: Number(done.executionMs) || 0,
    },
    usage: {
      used: done.used,
      limit: done.limit,
    },
  };
}

export async function readUsage(catalog, workspaceId) {
  const [plans] = await catalog.execute(
    `SELECT plan_code, created_at FROM workspaces WHERE id = ?`,
    [workspaceId]
  );
  const planCode = plans[0]?.plan_code || "trial";
  const onTrial = String(planCode).toLowerCase() === "trial";
  const endsAt = onTrial ? trialEndsAt(plans[0]?.created_at) : null;
  const expired = onTrial && trialHasEnded(plans[0]?.created_at);
  const [counts] = await catalog.execute(
    `SELECT COUNT(*) AS n
     FROM usage_events
     WHERE workspace_id = ?
       AND success = 1
       AND asked_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
       AND asked_at < DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
    [workspaceId]
  );
  return {
    used: Number(counts[0].n),
    limit: questionLimitForPlan(planCode),
    planCode,
    trialEndsAt: endsAt ? endsAt.toISOString() : null,
    expired,
  };
}

async function recordUsage(catalog, workspaceId, connectionId, result) {
  const tokens = Number(result.estimated_tokens);
  await catalog.execute(
    `INSERT INTO usage_events
       (workspace_id, connection_id, path_code, estimated_tokens, success)
     VALUES (?, ?, ?, ?, ?)`,
    [
      workspaceId,
      connectionId,
      result.path,
      Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0,
      result.executeError ? 0 : 1,
    ]
  );
}

export async function askQuestion({ catalog, qdrant, workspaceId, body, onEvent }) {
  const question = String(body?.question || "").trim();
  if (!question) throw new HttpError(400, "Enter a question.");
  if (question.length > 2000) throw new HttpError(400, "Question is too long.");
  let sqlModel;
  try {
    sqlModel = resolveSqlProvider(body?.provider);
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  const [rows] = await catalog.execute(
    `SELECT id, host, port, database_name, username, password_ciphertext, schema_text_chars
     FROM connections
     WHERE workspace_id = ?
     ORDER BY id
     LIMIT 1`,
    [workspaceId]
  );
  const row = rows[0];
  if (!row || Number(row.schema_text_chars) <= 0) {
    throw new HttpError(400, "Connect and index a database before asking a question.");
  }

  const usage = await readUsage(catalog, workspaceId);
  if (usage.expired) {
    throw new HttpError(402, "The 14-day free trial has ended. Subscribe to keep asking questions.");
  }
  if (usage.used >= usage.limit) {
    throw new HttpError(429, quotaMessage(usage.used, usage.limit));
  }

  let password = "";
  try {
    password = decryptSecret(row.password_ciphertext);
  } catch {
    throw new HttpError(500, "The stored database password could not be read.");
  }

  const source = sourceConfig({
    host: row.host,
    port: Number(row.port),
    user: row.username,
    password,
    database: row.database_name,
  });

  let result;
  try {
    result = await answerQuestion(
      question,
      {
        workspaceId,
        connectionId: Number(row.id),
        catalog,
        qdrant,
        source,
        provider: sqlModel.id,
      },
      (message) => onEvent({ step: "status", message: String(message) })
    );
  } catch (err) {
    onEvent({ step: "error", message: publicError(err, password) });
    return;
  }

  await recordUsage(catalog, workspaceId, Number(row.id), result);
  const after = await readUsage(catalog, workspaceId);
  console.log(`ask workspace=${workspaceId} path=${result.path} model=${result.model}`);
  onEvent({
    step: "done",
    path: result.path,
    provider: result.provider,
    model: result.model,
    modelLabel: result.modelLabel,
    schemaTextChars: result.schema_text_chars,
    summary: answerSummary(result),
    sql: result.executed_sql || result.query || null,
    explanation: result.explanation || "",
    rows: Array.isArray(result.rows) ? plainRows(result.rows) : null,
    executeError: result.executeError || null,
    schemaMs: result.schemaMs || 0,
    synthesisMs: result.synthesisMs || 0,
    executionMs: result.executionMs || 0,
    used: after.used,
    limit: after.limit,
  });
}
