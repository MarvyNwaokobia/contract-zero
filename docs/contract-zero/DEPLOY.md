# Deploying CONTRACT ZERO: Supabase + Railway + Vercel

**The three parts:**
- **Postgres** on Supabase;
- **the API** (Rust: economy, settlement worker, auth, NEAR) on Railway, from `apps/api/Dockerfile`;
- **the web app** (Next.js) on Vercel, from `apps/web`.

The contracts are already live on NEAR testnet (see NEAR.md), so nothing on chain changes here.

**No key or secret is ever committed or baked into an image.** The API reads its signing keys from one secret variable, `CZ_KEYS_JSON` (below).

## 1. Database (Supabase)

1. Create a project. The region should be close to the Railway region.
2. Copy a connection string. Use either:
   - **the Session pooler** (port 5432 on the pooler host), or
   - **the direct connection**.

   **Not the Transaction pooler (port 6543).** The API holds a session-level advisory lock as the single world writer and uses prepared statements, and the transaction pooler supports neither.
3. Append `?sslmode=require`. The API runs every migration on boot (they're embedded in the binary).
4. **To keep the current world, restore the local database instead of starting fresh:**
   ```sh
   pg_dump --no-owner --no-acl "$LOCAL_DATABASE_URL" | psql "$SUPABASE_DATABASE_URL"
   ```
   This keeps the world's tick, ledger, orders, standings and settlement history. A fresh database creates a new genesis world and realigns the actors' testnet balances to it on first boot. That works, but it erases the story so far.

## 2. API (Railway)

```sh
railway login                        # interactive, once
cd apps/api
railway init                         # or: railway link to an existing project
railway variables --set "DATABASE_URL=postgresql://…:5432/postgres?sslmode=require" \
  --set "CZ_ENV=production" \
  --set "FRONTEND_ORIGIN=https://<your-vercel-domain>" \
  --set "AUTH_COOKIE_SECURE=1" \
  --set "WORLD_TICK_SECS=60" --set "AGENT_EVERY_TICKS=1" \
  --set "CZ_WORLD=world2.contract-zero.testnet" --set "CZ_ASSETS=assets.contract-zero.testnet" \
  --set "CZ_SERVER_ACCOUNT=server.contract-zero.testnet" \
  --set "CZ_VANGUARD_ACCOUNT=vanguard.contract-zero.testnet" --set "CZ_VEX_ACCOUNT=vex.contract-zero.testnet" \
  --set "CZ_RELAYER_ACCOUNT=cz-relayer-9abaff.testnet" \
  --set "NEAR_RPC_URL=https://rpc.testnet.fastnear.com" \
  --set "ADMIN_TOKEN=$(openssl rand -hex 24)"
# Every signing key, as one secret, without it ever touching the terminal:
railway variables --set "CZ_KEYS_JSON=$(node ../../scripts/keys-json.mjs)"
railway up                           # builds apps/api/Dockerfile, health-checks /health
```

**Signing keys.**
- `scripts/keys-json.mjs` collects the v3 actor keys, the server key and the relayer key.
- It refuses to print to a terminal.
- It copies only the account, public key and private key, so a wallet's seed phrase stays on your machine.
- At startup the API writes the keys to a private directory (0700, with files 0600) and removes the variable from its environment.

**Port.** The API binds `BIND_ADDR`, else Railway's `PORT`, else 8080.

**Optional variables:**
| Variable | Purpose |
|---|---|
| `NEAR_AI_API_KEY` | The strategic planner. The NEAR AI account needs credits, or every call returns 402 |
| `SENTRY_DSN` | Error reporting |
| `ONECLICK_API_KEY` | A 1Click partner key; without one, the adapter pays 1Click's +25 bps |

**Keep `NEAR_INTENTS_EXECUTION` unset in production.** The game never needs live swaps.

**One instance only.** The world has a single writer, enforced by an advisory lock. `numReplicas` is 1 in `railway.toml`, and a second instance would refuse to start.

## 3. Web (Vercel)

```sh
cd apps/web
vercel link                          # project root: apps/web
vercel env add NEXT_PUBLIC_API_URL production       # https://<railway-domain>
vercel env add NEXT_PUBLIC_NEAR_NETWORK production  # testnet
vercel env add NEXT_PUBLIC_NEAR_RPC production      # https://rpc.testnet.fastnear.com
vercel deploy --prod
```

Then set `FRONTEND_ORIGIN` on Railway to the exact Vercel origin. In production, CORS and the CSRF origin check allow only that origin, and session cookies are `Secure; SameSite=None`.

**Don't set `NEXT_PUBLIC_CZ_DEV_HOOKS` in production.** Without it, the `/dev` routes and the test hooks are off.

**NEAR Auth (social sign-in).** NEAR's shared testnet login client accepts only `http://localhost:3000`. A deployed domain needs its own client from NEAR's dashboard; wallet sign-in works everywhere.

## 4. After the first deploy

1. **Health:** `GET /ready` returns `{"db":"up"}`. The startup log shows `migrations: applied N new`, and the settlement worker starts.
2. **Reconciliation:** `GET /reconciliation` returns `exact: true` once the queue drains. A fresh database aligns to the chain on boot (`settlement::bootstrap`).
3. **Smoke test:** run the probes against the deployed URLs, for example `node apps/web/probe-a11y.mjs https://<web> https://<api>` and `node scripts/supply-e2e.mjs https://<api>`.

## What was verified locally

| Check | Result |
|---|---|
| Production web build (`npm run build` in `apps/web`) | Builds; all routes prerender |
| API release build | Built with `cargo build` |
| The `CZ_KEYS_JSON` loader | Unit-tested: private file modes, mismatched or path-traversing entries refused |
| The container image | **Not verified here.** Docker's daemon wasn't running on this machine. The Dockerfile is a standard two-stage Rust build (rust:1-slim-bookworm → debian:bookworm-slim, with `libssl3` for TLS to Postgres) |
