import { createHash, randomBytes } from "node:crypto";

const COOKIE = "nlp_session";
const MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest();
}

export function readSessionToken(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== COOKIE) continue;
    const value = trimmed.slice(eq + 1);
    return value || null;
  }
  return null;
}

export function sessionCookie(token) {
  return [
    `${COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function expiresAt() {
  return new Date(Date.now() + MAX_AGE_SECONDS * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

export async function createSession(catalog, userId) {
  const token = randomBytes(32).toString("base64url");
  await catalog.execute(`DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()`);
  await catalog.execute(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [userId, hashToken(token), expiresAt()]
  );
  return token;
}

export async function sessionAccount(catalog, cookieHeader) {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  const [rows] = await catalog.execute(
    `SELECT u.id AS user_id, u.email, w.id AS workspace_id, w.name AS workspace_name, w.plan_code
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN workspaces w ON w.owner_user_id = u.id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()
     ORDER BY w.id
     LIMIT 1`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: Number(row.user_id),
    email: row.email,
    workspaceId: Number(row.workspace_id),
    workspaceName: row.workspace_name,
    planCode: row.plan_code,
  };
}

export async function deleteSession(catalog, cookieHeader) {
  const token = readSessionToken(cookieHeader);
  if (!token) return;
  await catalog.execute(`DELETE FROM sessions WHERE token_hash = ?`, [hashToken(token)]);
}

export function readBearerToken(header) {
  const value = String(header || "").trim();
  if (!value.toLowerCase().startsWith("bearer ")) return null;
  const token = value.slice(7).trim();
  return token || null;
}

export async function resolveAccount(catalog, req) {
  const bearer = readBearerToken(req.headers?.authorization);
  if (bearer) {
    const { accountFromApiKey } = await import("./api-keys.js");
    return accountFromApiKey(catalog, bearer);
  }
  return sessionAccount(catalog, req.headers?.cookie);
}
