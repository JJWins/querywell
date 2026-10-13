import { hashPassword, verifyPassword } from "../auth/password.js";
import { createSession } from "../auth/session.js";
import { HttpError } from "./errors.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function accountView(email, workspaceName) {
  return {
    email,
    workspaceName,
    planCode: "trial",
  };
}

function parseCredentials(body, { workspace = false } = {}) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be JSON.");
  }
  const email = String(body.email || "").trim().toLowerCase();
  const password = body.password == null ? "" : String(body.password);
  if (!EMAIL.test(email) || email.length > 255) {
    throw new HttpError(400, "Enter a valid email.");
  }
  if (password.length < 8 || password.length > 200) {
    throw new HttpError(400, "Password must be at least 8 characters.");
  }
  if (!workspace) return { email, password };
  const workspaceName = String(body.workspaceName || "").trim();
  if (!workspaceName || workspaceName.length > 255) {
    throw new HttpError(400, "Enter a workspace name.");
  }
  return { email, password, workspaceName };
}

export async function signup(catalog, body) {
  const { email, password, workspaceName } = parseCredentials(body, { workspace: true });
  const passwordHash = await hashPassword(password);
  const connection = await catalog.getConnection();
  let userId;
  try {
    await connection.beginTransaction();
    const [user] = await connection.execute(
      `INSERT INTO users (email, password_hash) VALUES (?, ?)`,
      [email, passwordHash]
    );
    userId = Number(user.insertId);
    await connection.execute(
      `INSERT INTO workspaces (name, owner_user_id, plan_code) VALUES (?, ?, 'trial')`,
      [workspaceName, userId]
    );
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    if (err?.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "An account with that email already exists.");
    }
    throw err;
  } finally {
    connection.release();
  }

  const token = await createSession(catalog, userId);
  return { token, account: accountView(email, workspaceName) };
}

export async function signin(catalog, body) {
  const { email, password } = parseCredentials(body);
  const [rows] = await catalog.execute(
    `SELECT u.id, u.password_hash, w.name AS workspace_name
     FROM users u
     JOIN workspaces w ON w.owner_user_id = u.id
     WHERE u.email = ?
     ORDER BY w.id
     LIMIT 1`,
    [email]
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, "Email or password is incorrect.");
  }
  const token = await createSession(catalog, Number(user.id));
  return { token, account: accountView(email, user.workspace_name) };
}
