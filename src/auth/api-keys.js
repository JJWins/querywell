import { randomBytes } from "node:crypto";
import { HttpError } from "../http/errors.js";
import { hashToken } from "./session.js";

const PREFIX = "ask_live_";
const MAX_ACTIVE_KEYS = 10;

function stamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function publicKey(row) {
  return {
    id: Number(row.id),
    name: row.name,
    prefix: row.key_prefix,
    createdAt: stamp(row.created_at),
    lastUsedAt: stamp(row.last_used_at),
  };
}

export async function accountFromApiKey(catalog, token) {
  if (!token || !String(token).startsWith(PREFIX)) return null;
  const [rows] = await catalog.execute(
    `SELECT k.id AS key_id, u.id AS user_id, u.email,
            w.id AS workspace_id, w.name AS workspace_name, w.plan_code
     FROM api_keys k
     JOIN workspaces w ON w.id = k.workspace_id
     JOIN users u ON u.id = w.owner_user_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL
     LIMIT 1`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  await catalog.execute(
    `UPDATE api_keys SET last_used_at = UTC_TIMESTAMP() WHERE id = ?`,
    [row.key_id]
  );
  return {
    userId: Number(row.user_id),
    email: row.email,
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    planCode: row.plan_code,
  };
}

export async function listApiKeys(catalog, workspaceId) {
  const [rows] = await catalog.execute(
    `SELECT id, name, key_prefix, created_at, last_used_at
     FROM api_keys
     WHERE workspace_id = ? AND revoked_at IS NULL
     ORDER BY id DESC`,
    [workspaceId]
  );
  return rows.map(publicKey);
}

export async function createApiKey(catalog, workspaceId, name) {
  const label = String(name || "").trim();
  if (!label) throw new HttpError(400, "Name the key.");
  if (label.length > 80) throw new HttpError(400, "Key name is too long.");

  const [counts] = await catalog.execute(
    `SELECT COUNT(*) AS n
     FROM api_keys
     WHERE workspace_id = ? AND revoked_at IS NULL`,
    [workspaceId]
  );
  if (Number(counts[0].n) >= MAX_ACTIVE_KEYS) {
    throw new HttpError(400, "This workspace already has 10 active keys.");
  }

  const secret = PREFIX + randomBytes(32).toString("base64url");
  const prefix = secret.slice(0, PREFIX.length + 8);
  const [result] = await catalog.execute(
    `INSERT INTO api_keys (workspace_id, name, key_hash, key_prefix)
     VALUES (?, ?, ?, ?)`,
    [workspaceId, label, hashToken(secret), prefix]
  );
  return {
    id: Number(result.insertId),
    name: label,
    prefix,
    secret,
    createdAt: stamp(new Date()),
    lastUsedAt: null,
  };
}

export async function revokeApiKey(catalog, workspaceId, keyId) {
  const id = Number(keyId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "That key was not found.");
  const [result] = await catalog.execute(
    `UPDATE api_keys
     SET revoked_at = UTC_TIMESTAMP()
     WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    [id, workspaceId]
  );
  if (!result.affectedRows) throw new HttpError(404, "That key was not found.");
  return { ok: true };
}
