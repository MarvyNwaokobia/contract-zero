# Sign-in, sessions and quick trade

**Goal:** a player signs in with Google (or email or a passkey) and never sees a seed phrase. The server knows, cryptographically, which on-chain account the player controls. Trading takes either an explicit approval or a quick-trade permission the player granted, scoped to the game and limited by the contract. Neither the server nor the browser ever holds unrestricted authority over a player's assets.

Every claim below is marked:
- **Verified**: run on NEAR testnet or in a real browser on 2026-11-08, with evidence.
- **Documented**: from NEAR's docs or the published SDK source; not exercised end to end.

## 1. The three ways in

| Path | Who | How the account is proven | Status |
|---|---|---|---|
| **Continue with Google** (default) | New players | NEAR Auth: Auth0 login → the server verifies the ID token (RS256, NEAR Auth's JWKS, issuer, audience, issued < 10 min ago) → MPC derives the player's key from the token's subject → the account is that key's implicit account, sponsored on first sign-in | Up to the hosted login: **Verified**. Completing a Google login: **not run** (needs a human Google account) |
| **Email or passkey** | New players | Same as Google (same hosted page) | Same as above |
| **I already have a NEAR wallet** | Existing NEAR users | NEAR Connect (HOT, Meteor, Intear, MyNearWallet, Nightly, Ledger, …) → a NEP-413 signed sign-in message over a single-use server nonce → the server verifies the signature and that RPC lists the key as a **full-access** key of the account | **Verified** (`scripts/auth-e2e.mjs`; in-wallet UI not automated) |

**A session is an HttpOnly, `SameSite=Lax` cookie** holding 32 random bytes; the database stores only its SHA-256. It lasts 7 days and is revoked on sign-out.
- **Every action that acts for a player** (missions, quotes, confirms, relaying) takes the player from the session.
- **A `player` in a request body is ignored if it matches** the session and refused (403) if it doesn't.

**Verified on testnet** (`scripts/auth-e2e.mjs`):

| Check | Result |
|---|---|
| Quote, mission start or relay with no session, even with a player ID in the body | 401 |
| Wallet sign-in with the account's full-access key | Session for `player.contract-zero.testnet` |
| The same signed challenge replayed | 401 |
| Sign-in with one of the account's *limited* keys | 401 "that key is a limited key" |
| Claiming `vanguard.contract-zero.testnet` with the player's key | 401 "that key does not belong to the account" |
| Signed in, quoting as another account | 403 |
| After sign-out | 401 |

## 2. NEAR Auth (the new FastAuth): what we found

| Question | Finding | Status |
|---|---|---|
| Credentials | NEAR publishes a **shared testnet client** (`np8paqIpMWmNbzT4xAvOOapZBjsOpptl`, domain `login.testnet.fast-auth.com`), "for development only". Mainnet needs your own credentials through NEAR's application form (callback, logout and web-origin URLs, HTTPS only; reviewed by NEAR) | Documented |
| Testnet origin | The shared client's allowed callback is **only `http://localhost:3000`**. `http://localhost:3100` and any other domain get "Callback URL mismatch" | **Verified** (Auth0 `/authorize` probe) |
| Login providers | The hosted testnet page offers **Google, email, passkey**. No Apple | **Verified** |
| Contracts | `fast-auth.testnet`, `jwt.fast-auth.testnet`, `auth0.jwt.fast-auth.testnet` and the MPC signer `v1.signer-prod.testnet` are deployed. The docs disagree on `fast-auth.testnet` vs `fast-auth-beta-001.testnet`; both exist, and the SDK defaults and most pages use `fast-auth.testnet` | **Verified** (on chain) |
| Account derivation | Key = `v1.signer-prod.testnet.derived_public_key({ path: "jwt#https://login.testnet.fast-auth.com/#<sub>", predecessor: "fast-auth.testnet", domain_id: 1 })`. It's deterministic: the same subject always gives the same key, and different subjects give different keys | **Verified** (view calls) |
| The account itself | The SDK's `createAccount` builds a `create_account` call that *someone else* must submit and pay for. No account is created automatically, and nothing is documented for testnet. **Our choice:** the implicit account of the derived key (its ID is the key's hex), funded once by our relayer. No name to register, and the key is necessarily full-access | Design |
| Signing | Every signature is an **Auth0 popup or redirect** that binds the exact transaction or delegate action into the token (`scope: transaction:sign`, claim `fatxn`). Then a funded account submits `sign(guard_id, verify_payload, sign_payload, algorithm)` to `fast-auth.testnet` and receives the MPC signature | Documented + SDK source |
| AddKey, session keys | Not documented. The SDK signs arbitrary transactions and delegate actions, so an `AddKey` *should* be signable. **Not verified** | Unverified |
| Message signing (NEP-413) | Described in the docs, but **absent from the published package** (`@fast-auth-near/javascript-provider` 1.4.1). So for sign-in we verify the ID token and derive the key server-side instead | **Verified** (package source) |
| Gas sponsorship | "A relayer is optional", and an app runs its own (a funded account). No hosted testnet relayer URL is documented | Documented |
| Packages | `@fast-auth-near/javascript-provider` 1.4.1, `@fast-auth-near/browser-sdk` 1.4.2 (ISC, last published June/July 2026). They pin `near-api-js` ^5. The game mirrors their (small) provider logic on `@auth0/auth0-spa-js` directly so the app keeps one `near-api-js` | **Verified** (npm) |

**Alternative considered: Privy.** NEAR's docs have a Privy-through-NEAR-Connect tutorial, where Privy creates an embedded wallet and signs through `signRawHash`. It would also need credentials: a Privy app ID and a dashboard account. It's custodial-adjacent too: keys are sharded by Privy. NEAR Auth is NEAR's own MPC, its testnet client is public, and the derivation is checkable on chain, so it's the better fit. Privy remains a drop-in option behind NEAR Connect if NEAR Auth's mainnet approval stalls.

## 3. Quick trade: scoped, revocable sessions enforced on chain

Without quick trade, each trade is approved explicitly: a wallet prompt, or a NEAR Auth popup. With quick trade, the player approves once:

1. **A session key is added to their account.** It's generated in the browser and never leaves it. It's a function-call key that can call only `accept_offer`, `accept_bid`, `place_order`, `accept_proposal`, `cancel_order` and `revoke_session` on `world2`, with a 1 NEAR gas allowance. (A function-call key's allowance is charged at a pessimistic gas price for every call's prepaid gas, so a supply order's 80 Tgas needs headroom; the key still can't move assets outside these methods, and the contract holds each call to the player's registered session budgets.)
2. **A session is registered on `world2`** with a credit budget, a sale budget (units) and an expiry (≤ 7 days), plus a refundable 0.001 NEAR storage deposit.

`world2` (code `2mxwU9PEbYbDuvsunxkPGBwcXPL88FPkpkgxVYLxUp5W`, [upgrade](https://testnet.nearblocks.io/txns/7dkJtkBgVvwRmAp8QpgXQAVhuzP8Ejyyr9uJzsTHQwwN)) looks up the transaction's signing key (`env::signer_account_pk`) when a quote is accepted. If that key is a session:
- it must be unexpired and not revoked;
- the trade must fit the remaining budget, which it then spends;
- a revoked session stays as a tombstone, so the key is powerless even before it's deleted;
- a session key can't open or widen its own session.

Other keys (the player's own) aren't limited. 10 contract tests.

**Verified on testnet** (`scripts/auth-e2e.mjs`):

| Step | Evidence |
|---|---|
| Session key added (player's authority) | [`ENRXwxs6…`](https://testnet.nearblocks.io/txns/ENRXwxs659G8oHvK4fn6gJv1imx3PQ531JRAerYfPhBP) |
| Session opened, budget 120 cr. The relayer paid the gas | [`3MaUZ3pL…`](https://testnet.nearblocks.io/txns/3MaUZ3pLm5hR62fyAcCKCh11NpfGrxBqPmNTPP7BNbUj) |
| A trade signed by the session key, with no prompt: 1 med for 80 cr. Settled on chain; budget 120 → 40 | [`Gsc1dX5D…`](https://testnet.nearblocks.io/txns/Gsc1dX5DtWhMamR5P3xwWsZ86J859Fogm2gzxRZbYSsb) |
| An 83 cr trade with 40 left: **refused by the contract** ("over this session's credit budget") | [`HkJmnfFt…`](https://testnet.nearblocks.io/txns/HkJmnfFtLT8cwzNyhAMDr7n68XJPocWukVydisZJ1YhM) |
| The session key signs itself out (relayed) | [`HhwbaRgp…`](https://testnet.nearblocks.io/txns/HhwbaRgpQRKfMBzAvteMoHSjyGYFKdi7V7WhKueDkmdS) |
| The same key trading afterwards: **refused** ("this session was revoked") | [`Ab9uhY4B…`](https://testnet.nearblocks.io/txns/Ab9uhY4Bj4sfo6ZWp2byizxTTmCcsYFWVGGZjZiLUFFT) |
| The key deleted by the player | [`GT879CdK…`](https://testnet.nearblocks.io/txns/GT879CdK8urg6jdzZcmLbQj5kLVdAS127d1suPegXc5v) |
| **In the browser** (`apps/web/probe-auth.mjs`, real Chrome): a signed-in player with quick trade on clicks Buy → Trade with no popup, and it settles on chain | Quote [`HocJfgBW…`](https://testnet.nearblocks.io/txns/HocJfgBWQCWrnumKUuzDji4KZUCeqQmrq46YxWcJDmR2), trade [`Gk6Q2eVS…`](https://testnet.nearblocks.io/txns/Gk6Q2eVSg3aJtaNjA7wn7BxTd6XdJ7mot8Lgug1k2oFm) |

### Why trades are never gas-relayed (verified)

We first relayed a session-key trade as a NEP-366 meta-transaction ([`A8C8GyF3…`](https://testnet.nearblocks.io/txns/A8C8GyF37VDMjYXt9qdfgksMG6qXrcQXBQDCLq1QcrPV)). `cz-assets` refused it: "a leg may only debit an actor or the transaction signer". Inside a meta-transaction, contracts see the **relayer** as `signer_account_id` and `signer_account_pk`. That has two consequences:
1. **The asset contract couldn't verify the player's consent,** and correctly refused.
2. **The controller couldn't see which key signed,** so it couldn't have applied the session's budget.

So a relayed call can *never* move a player's assets, and trades must be transactions the player's key (wallet, MPC key or session key) signs directly. The API's relay refuses `accept_offer` and `accept_bid` before submitting anything.

**Gas comes from the player's account:**
- Wallet players pay their own.
- NEAR Auth accounts receive 0.1 NEAR once at sign-in, from the relayer. That covers storage, the session deposit and the up-front gas reservation; an accept burns about 0.001 NEAR, and the rest of the reservation is refunded.

### The relayer

`cz-relayer-9abaff.testnet` ([created by the testnet faucet service](https://testnet.nearblocks.io/txns/FLfVfxSvXFcyUxsCeXPyXDECRjLoANMo2F1emjT4fEMd), 10 NEAR). Its key is stored outside the repository (`~/.contract-zero/keys/relayer/`).
- **It holds a gas float and no game assets.**
- **It relays only a player's own, correctly signed delegate actions,** on an allow-list:
  - open or close a session (`register_session` with exactly the 0.001 NEAR deposit, `revoke_session`);
  - add a key to the player's own account, only if it's a function-call key scoped to `world2` and the session methods, with an allowance ≤ 1 NEAR;
  - delete one of the player's own keys.
- **A NEAR Auth player's own signed transaction** goes through the game only if it calls one of those session methods on `world2`, with no deposit and at most 120 Tgas. The allow-list and the browser's key are pinned together by a test (`auth::tests::the_web_clients_quick_trade_key_is_one_the_relayer_accepts`).
- **Verified:** an `mt_transfer` on `cz-assets` was refused before submission (401).

## 4. What remains to verify, and how

| Item | Why not yet | How to verify |
|---|---|---|
| A real Google, email or passkey sign-in end to end (server token check, derivation, sponsorship) | Needs a human login | Run the web app on **`http://localhost:3000`** with the API's relayer configured, click Continue with Google. The menu should show the signed-in player; the account is the 64-hex implicit account, funded with 0.1 NEAR |
| NEAR Auth signing (`fast-auth.testnet.sign`) for trades and for turning on quick trade | Needs a real NEAR Auth token. The `sign` deposit is undocumented (SDK default 0; one guide uses 1 yocto). `NEAR_AUTH_SIGN_DEPOSIT` sets it | After signing in with Google, buy something on the Exchange (one popup), then turn on quick trade (two popups) |
| Wallet sign-in UI in each wallet | Wallet extensions and apps can't be automated here | Use "I already have a NEAR wallet" with a testnet wallet |
| Production | The shared client is development-only and localhost-only | Apply for NEAR Auth credentials (form linked from docs.auth.near.org), then set `NEAR_AUTH_CLIENT_ID` / `NEAR_AUTH_DOMAIN` (API) |

## Configuration

API (`apps/api/.env`):
- `CZ_RELAYER_ACCOUNT`, `CZ_RELAYER_KEY_FILE`: the relayer. Without them, quick-trade setup relaying and social-account sponsorship are off.
- `NEAR_AUTH_CLIENT_ID`, `NEAR_AUTH_DOMAIN`, `NEAR_AUTH_SIGNING_AUDIENCE`, `NEAR_AUTH_CONTRACT`, `NEAR_AUTH_MPC`: default to NEAR's published testnet values.
- `AUTH_SPONSOR_YOCTO`: default 0.1 NEAR.
- `AUTH_COOKIE_SECURE=1` behind HTTPS.
- `AUTH_DEV_LOGIN=1`: off-chain development only. The API refuses to start with it while settlement is on NEAR.

Web: the API must be on the same site as the page, because the session is a `SameSite` cookie. For loopback URLs the client aligns `localhost` and `127.0.0.1` automatically.
