# Local and beta

## URLs

| Where | URL |
|---|---|
| Local | http://127.0.0.1:1112 |
| Beta | https://beta.querywell.in |
| Ask API docs | `/docs` |

`APP_PORT` in `.env` is `1112`. Local and beta must hit that process.

## Start

```powershell
cd "G:\Test programs\nlp_saas"
npm start
```

Needs MySQL (`nlp_saas` catalog), Qdrant at `http://127.0.0.1:6333`, and embeddings at `http://192.168.1.235:11435`. Keys and catalog credentials stay in `.env`.

## Tunnel

Named tunnel `querywell` → https://beta.querywell.in. Start and config: [cloudflare-tunnel.md](cloudflare-tunnel.md).

If port 1112 is already in use, stop that process before `npm start`.

## Sign-in

| Field | Value |
|---|---|
| Email | `phase2a-1012@example.com` |
| Password | `Phase2Account9` |
| Workspace | Phase2 Desk |

Local admin. Same sign-in page. The workspace is on the Scale plan, so the 14-day trial and the 30-question cap do not apply.

| Field | Value |
|---|---|
| Email | `admin@querywell.local` |
| Password | `Admin-Ufvz09Pq6r5j` |
| Workspace | Admin |

Same catalog on local and beta. Trial is 30 questions over 14 days. Create API keys at `/keys`.

## Demo MySQL

Read-only user `nlq_tier_ro` / `nlq-tier-readonly` on `127.0.0.1:3306`. Databases and sample questions: [test-schemas.md](test-schemas.md).
