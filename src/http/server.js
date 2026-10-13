import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiKey, listApiKeys, revokeApiKey } from "../auth/api-keys.js";
import { clearSessionCookie, deleteSession, readBearerToken, resolveAccount, sessionAccount, sessionCookie } from "../auth/session.js";
import { ensureCatalogTables } from "../db/migrate.js";
import { createCatalogPool, ensureCatalogDatabase } from "../db/pool.js";
import { createQdrantClient } from "../index/qdrant.js";
import { signin, signup } from "./accounts.js";
import { createCheckoutSession, createPortalSession, handleStripeWebhook } from "../billing/stripe.js";
import { askJsonBody, askQuestion, prefersJson, readUsage } from "./ask.js";
import { indexConnection, readConnection } from "./connect.js";
import { HttpError } from "./errors.js";
import { renderView } from "./render.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const assets = {
  "/app.css": "app.css",
  "/app.js": "app.js",
};
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendHtml(res, status, html, extraHeaders = {}) {
  const payload = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Request is too large."));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (!req.destroyed) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => reject(new HttpError(400, "Could not read the request.")));
  });
}

function readJson(req) {
  return readBody(req, 32768).then((rawBuffer) => {
    const raw = rawBuffer.toString("utf8");
    if (!raw) return {};
    try {
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "Request body must be JSON.");
      }
      return body;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "Request body must be JSON.");
    }
  });
}

async function sendFile(res, name) {
  const filePath = path.join(publicDir, name);
  const body = await readFile(filePath);
  const ext = path.extname(name);
  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function accountJson(account) {
  return {
    email: account.email,
    workspaceName: account.workspaceName,
    planCode: account.planCode,
  };
}

export function createApp({ catalog, qdrant }) {
  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    try {
      if (req.method === "GET" && pathname === "/") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (account) {
          redirect(res, "/ask");
          return;
        }
        const html = await renderView("home", {
          title: "Querywell — Ask your database in plain English",
        }, { layout: "main" });
        sendHtml(res, 200, html);
        return;
      }

      if (req.method === "GET" && pathname === "/signin") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (account) {
          redirect(res, "/ask");
          return;
        }
        const html = await renderView("signin", {
          title: "Sign In — Querywell",
          page: "signin",
        }, { layout: "main" });
        sendHtml(res, 200, html);
        return;
      }

      if (req.method === "GET" && pathname === "/signup") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (account) {
          redirect(res, "/connect");
          return;
        }
        const html = await renderView("signup", {
          title: "Create Your Workspace — Querywell",
          page: "signup",
        }, { layout: "main" });
        sendHtml(res, 200, html);
        return;
      }

      if (req.method === "GET" && pathname === "/connect") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) {
          redirect(res, "/signin");
          return;
        }
        const [connection, usage] = await Promise.all([
          readConnection(catalog, account.workspaceId),
          readUsage(catalog, account.workspaceId).catch(() => null),
        ]);
        const html = await renderView("connect", {
          title: "Database Source — Querywell",
          account: accountJson(account),
          connection,
          usage,
          activeTab: "connect",
        }, { layout: "app" });
        sendHtml(res, 200, html);
        return;
      }

      if (req.method === "GET" && pathname === "/ask") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) {
          redirect(res, "/signin");
          return;
        }
        const [connection, usage] = await Promise.all([
          readConnection(catalog, account.workspaceId),
          readUsage(catalog, account.workspaceId).catch(() => null),
        ]);
        const html = await renderView("ask", {
          title: "SQL Studio — Querywell",
          account: accountJson(account),
          connection,
          usage,
          activeTab: "ask",
        }, { layout: "app" });
        sendHtml(res, 200, html);
        return;
      }

      if (req.method === "GET" && pathname === "/keys") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) {
          redirect(res, "/signin");
          return;
        }
        const [connection, usage, keys] = await Promise.all([
          readConnection(catalog, account.workspaceId),
          readUsage(catalog, account.workspaceId).catch(() => null),
          listApiKeys(catalog, account.workspaceId),
        ]);
        const html = await renderView("keys", {
          title: "API Keys — Querywell",
          account: accountJson(account),
          connection,
          usage,
          keys,
          activeTab: "keys",
        }, { layout: "app" });
        sendHtml(res, 200, html);
        return;
      }

      if (req.method === "GET" && assets[pathname]) {
        await sendFile(res, assets[pathname]);
        return;
      }

      if (req.method === "POST" && pathname === "/api/stripe/webhook") {
        const raw = await readBody(req, 1048576);
        sendJson(res, 200, await handleStripeWebhook(catalog, raw, req.headers["stripe-signature"]));
        return;
      }

      if (req.method === "POST" && pathname === "/api/billing/checkout") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        sendJson(res, 200, await createCheckoutSession(catalog, account, await readJson(req)));
        return;
      }

      if (req.method === "POST" && pathname === "/api/billing/portal") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        sendJson(res, 200, await createPortalSession(catalog, account.workspaceId));
        return;
      }

      if (req.method === "POST" && pathname === "/api/signup") {
        const result = await signup(catalog, await readJson(req));
        sendJson(res, 201, result.account, { "Set-Cookie": sessionCookie(result.token) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/signin") {
        const result = await signin(catalog, await readJson(req));
        sendJson(res, 200, result.account, { "Set-Cookie": sessionCookie(result.token) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/signout") {
        await deleteSession(catalog, req.headers.cookie);
        sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/usage") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        sendJson(res, 200, await readUsage(catalog, account.workspaceId));
        return;
      }

      if (req.method === "GET" && pathname === "/api/me") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        sendJson(res, 200, accountJson(account));
        return;
      }

      if (pathname === "/api/connection") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        if (req.method === "GET") {
          const connection = await readConnection(catalog, account.workspaceId);
          sendJson(res, 200, { connection });
          return;
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          let started = false;
          const onEvent = (event) => {
            if (!started) {
              res.writeHead(200, {
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              });
              started = true;
            }
            res.write(`${JSON.stringify(event)}\n`);
          };
          try {
            await indexConnection({
              catalog,
              qdrant,
              workspaceId: account.workspaceId,
              body,
              onEvent,
            });
          } catch (err) {
            if (started) {
              const message = err instanceof HttpError ? err.message : "Could not index that database.";
              res.write(`${JSON.stringify({ step: "error", message })}\n`);
              res.end();
              return;
            }
            throw err;
          }
          if (started) res.end();
          return;
        }
      }

      if (req.method === "GET" && pathname === "/api/keys") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        sendJson(res, 200, { keys: await listApiKeys(catalog, account.workspaceId) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/keys") {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        const body = await readJson(req);
        sendJson(res, 201, { key: await createApiKey(catalog, account.workspaceId, body?.name) });
        return;
      }

      const revokeMatch = pathname.match(/^\/api\/keys\/(\d+)\/revoke$/);
      if (req.method === "POST" && revokeMatch) {
        const account = await sessionAccount(catalog, req.headers.cookie);
        if (!account) throw new HttpError(401, "Sign in required.");
        sendJson(res, 200, await revokeApiKey(catalog, account.workspaceId, revokeMatch[1]));
        return;
      }

      if (req.method === "POST" && pathname === "/api/ask") {
        const bearer = readBearerToken(req.headers.authorization);
        const account = await resolveAccount(catalog, req);
        if (!account) {
          throw new HttpError(401, bearer ? "API key is not valid." : "Sign in required.");
        }
        const body = await readJson(req);
        const json = prefersJson(req.headers.accept);
        if (json) {
          const events = [];
          await askQuestion({
            catalog,
            qdrant,
            workspaceId: account.workspaceId,
            body,
            onEvent: (event) => events.push(event),
          });
          const failed = events.find((event) => event.step === "error");
          if (failed) {
            sendJson(res, 502, { error: failed.message || "Could not answer that question." });
            return;
          }
          const done = events.find((event) => event.step === "done");
          if (!done) {
            sendJson(res, 502, { error: "Could not answer that question." });
            return;
          }
          if (done.executeError) {
            sendJson(res, 502, { error: done.executeError });
            return;
          }
          sendJson(res, 200, askJsonBody(String(body?.question || "").trim(), done));
          return;
        }
        let started = false;
        const onEvent = (event) => {
          if (!started) {
            res.writeHead(200, {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            });
            started = true;
          }
          res.write(`${JSON.stringify(event)}\n`);
        };
        try {
          await askQuestion({
            catalog,
            qdrant,
            workspaceId: account.workspaceId,
            body,
            onEvent,
          });
        } catch (err) {
          if (started) {
            const message = err instanceof HttpError ? err.message : "Could not answer that question.";
            res.write(`${JSON.stringify({ step: "error", message })}\n`);
            res.end();
            return;
          }
          throw err;
        }
        if (started) res.end();
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "Not found." });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found.");
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "Something went wrong.";
      sendJson(res, status, { error: message });
    }
  };
}

const port = Number(process.env.APP_PORT || process.env.PORT || 3000);
await ensureCatalogDatabase();
const catalog = createCatalogPool();
await ensureCatalogTables(catalog);
const qdrant = createQdrantClient();
const server = createServer(createApp({ catalog, qdrant }));
server.listen(port, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${port}`);
});
