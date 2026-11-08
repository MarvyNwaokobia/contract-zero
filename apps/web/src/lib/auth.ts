// Sign-in, sessions and quick trade for CONTRACT ZERO.
//
// Three ways in, all ending in a server session that is bound to an on-chain account
// by cryptographic proof (never by a typed-in id):
//  - Google / email / passkey: NEAR Auth. Auth0 login; NEAR's MPC network controls a
//    key derived from the identity; the player's account is that key's implicit
//    account (sponsored on first sign-in). The server verifies the identity token.
//  - Existing NEAR users: NEAR Connect wallet + a NEP-413 signed sign-in message.
//
// The NEAR Auth steps mirror @fast-auth-near/javascript-provider 1.4.1 (Auth0 popup
// with the transaction or delegate action bound into the token, then the token sent
// to fast-auth.testnet's `sign`), implemented on @auth0/auth0-spa-js directly so the
// app keeps one near-api-js version.
import type { Auth0Client } from '@auth0/auth0-spa-js'
import {
  Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, Signature, SignedTransaction,
  actions, buildDelegateAction, createTransaction, encodeDelegateAction, encodeSignedDelegate, encodeTransaction, baseDecode,
} from 'near-api-js'
import { API } from '@/lib/api'

export const RPC = process.env.NEXT_PUBLIC_NEAR_RPC ?? 'https://rpc.testnet.fastnear.com'
const provider = () => new JsonRpcProvider({ url: RPC })

export interface Session {
  account: string
  method: 'wallet' | 'near_auth' | 'dev'
  provider: 'google' | 'apple' | 'email' | 'wallet' | 'dev' | null
  subject: string | null
  public_key: string | null
  expires_at: string
}

export interface AuthConfig {
  near_auth: { domain: string; client_id: string; fast_auth_contract: string; mpc_contract: string; signing_audience: string }
  relayer: string | null
  controller: string | null
  wallet: { message: string; recipient: string }
  dev_login: boolean
}

/** NEAR's shared testnet login client only accepts this origin (verified 2026-11-08). */
export const SHARED_TESTNET_CLIENT = 'np8paqIpMWmNbzT4xAvOOapZBjsOpptl'
export const SHARED_TESTNET_ORIGIN = 'http://localhost:3000'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `HTTP ${r.status}`), { status: r.status })
  return body as T
}

export const auth = {
  config: () => call<AuthConfig>('/auth/config'),
  session: () => call<Session>('/auth/session').catch((e) => { if ((e as { status?: number }).status === 401) return null; throw e }),
  logout: async () => {
    await call('/auth/logout', { method: 'POST' })
    try { await (await auth0())?.logout({ openUrl: false }) } catch { /* not signed in with NEAR Auth */ }
    clearSessionKey()
  },
  dev: (account_id: string) => call<Session>('/auth/dev', { method: 'POST', body: JSON.stringify({ account_id }) }),
}

// ── NEAR Auth (Google / email / passkey) ────────────────────────────────────

let client: Promise<Auth0Client | null> | null = null
let cfg: AuthConfig | null = null

async function auth0(): Promise<Auth0Client | null> {
  if (!client) {
    client = (async () => {
      cfg = cfg ?? await auth.config()
      const { Auth0Client } = await import('@auth0/auth0-spa-js')
      return new Auth0Client({ domain: cfg.near_auth.domain, clientId: cfg.near_auth.client_id, authorizationParams: {}, cacheLocation: 'memory' })
    })()
  }
  return client
}

/** Why social sign-in can't run here, if it can't. */
export async function socialBlocker(): Promise<string | null> {
  cfg = cfg ?? await auth.config()
  if (cfg.near_auth.client_id === SHARED_TESTNET_CLIENT && window.location.origin !== SHARED_TESTNET_ORIGIN) {
    return `Social sign-in on testnet uses NEAR's shared development login, which only accepts ${SHARED_TESTNET_ORIGIN}. Open the game there, or configure your own NEAR Auth credentials.`
  }
  return null
}

/** Google, email or passkey through NEAR Auth's hosted login. The server verifies the
 *  identity token, derives the player's account and opens a session. */
export async function signInSocial(): Promise<Session> {
  const blocked = await socialBlocker()
  if (blocked) throw new Error(blocked)
  const c = (await auth0())!
  await c.loginWithPopup({ authorizationParams: { prompt: 'login' } })
  const claims = await c.getIdTokenClaims()
  if (!claims?.__raw) throw new Error('sign-in was not completed')
  await call('/auth/near-auth', { method: 'POST', body: JSON.stringify({ id_token: claims.__raw }) })
  return (await auth.session())!
}

async function mpcSign(bound: { transaction?: number[]; delegateAction?: number[] }, payload: Uint8Array): Promise<Uint8Array> {
  const c = (await auth0())!
  // The popup binds this exact payload into the signing token (Auth0 re-authenticates).
  await c.loginWithPopup({ authorizationParams: { audience: cfg!.near_auth.signing_audience, scope: 'transaction:sign', ...bound } })
  const token = await c.getTokenSilently({ authorizationParams: { audience: cfg!.near_auth.signing_audience } })
  const r = await call<{ signature_b64: string | null; status: unknown }>('/relay/near-auth-sign', { method: 'POST', body: JSON.stringify({ verify_payload: token, sign_payload: Array.from(payload) }) })
  if (!r.signature_b64) throw new Error(`signing failed: ${JSON.stringify(r.status)}`)
  const mpc = JSON.parse(atob(r.signature_b64)) as { signature?: number[] }
  if (!mpc.signature || mpc.signature.length !== 64) throw new Error('unexpected signature from the signing network')
  return Uint8Array.from(mpc.signature)
}

async function accessKeyNonce(account: string, publicKey: string): Promise<bigint> {
  const r = await provider().viewAccessKey({ accountId: account, publicKey })
  return BigInt(r.nonce)
}

/** A NEAR Auth player signs one transaction (one approval popup) and sends it. */
async function socialSendTx(session: Session, receiverId: string, action: ReturnType<typeof actions.functionCall>): Promise<string> {
  const pk = PublicKey.fromString(session.public_key!)
  const nonce = (await accessKeyNonce(session.account, session.public_key!)) + 1n
  const block = await provider().viewBlock({ finality: 'final' })
  const tx = createTransaction(session.account, pk, receiverId, nonce, [action], baseDecode(block.header.hash))
  const bytes = encodeTransaction(tx)
  const sig = await mpcSign({ transaction: Array.from(bytes) }, bytes)
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: sig }) })
  const out = await provider().sendTransaction(signed)
  return out.transaction.hash
}

/** A NEAR Auth player signs one delegate action (one popup); the relayer pays the gas. */
async function socialRelay(session: Session, receiverId: string, action: ReturnType<typeof actions.functionCall>): Promise<unknown> {
  const pk = PublicKey.fromString(session.public_key!)
  const nonce = (await accessKeyNonce(session.account, session.public_key!)) + 1n
  const block = await provider().viewBlock({ finality: 'final' })
  const da = buildDelegateAction({ actions: [action], maxBlockHeight: BigInt(block.header.height) + 120n, nonce, publicKey: pk, receiverId, senderId: session.account })
  const bytes = encodeDelegateAction(da)
  const sig = await mpcSign({ delegateAction: Array.from(bytes) }, bytes)
  // Borsh-encoded by schema; near-api-js 7 doesn't export the SignedDelegate class at runtime.
  const sd = { delegateAction: da, signature: new Signature({ keyType: 0, data: sig }) } as unknown as Parameters<typeof encodeSignedDelegate>[0]
  return call('/relay/delegate', { method: 'POST', body: JSON.stringify({ signed_delegate: btoa(String.fromCharCode(...encodeSignedDelegate(sd))) }) })
}

// ── Existing NEAR users: wallet + NEP-413 ──────────────────────────────────

export async function signInWallet(): Promise<Session> {
  const { connect, signMessage } = await import('@/lib/wallet')
  const account = await connect()
  if (!account) throw new Error('no account selected')
  const ch = await call<{ nonce: string; message: string; recipient: string }>('/auth/challenge', { method: 'POST' })
  const nonce = Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0))
  const signed = await signMessage({ message: ch.message, recipient: ch.recipient, nonce })
  await call('/auth/wallet', { method: 'POST', body: JSON.stringify({ account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: ch.nonce }) })
  return (await auth.session())!
}

// ── Quick trade: a scoped, revocable session key ───────────────────────────
//
// The key lives only in this browser. On chain it can call nothing but accept_offer,
// accept_bid and revoke_session on the game controller, and the controller holds it
// to the budgets and expiry the player approved. Sign-out revokes it.

const SK = 'cz_session_key'
type Stored = { account: string; secret: string; expires: number }

export function loadSessionKey(account: string): KeyPair | null {
  try {
    const s = JSON.parse(localStorage.getItem(SK) ?? 'null') as Stored | null
    if (!s || s.account !== account || s.expires < Date.now()) return null
    return KeyPair.fromString(s.secret as Parameters<typeof KeyPair.fromString>[0])
  } catch { return null }
}

function clearSessionKey() {
  try { localStorage.removeItem(SK) } catch { /* ignore */ }
}

export interface QuickTradeLimits { credits: number; units: number; hours: number }

/** Open quick trade: add the scoped key and register its budgets, with the player's
 *  own authority (wallet approval, or NEAR Auth approvals). */
export async function enableQuickTrade(session: Session, limits: QuickTradeLimits): Promise<void> {
  cfg = cfg ?? await auth.config()
  const world = cfg.controller
  if (!world) throw new Error('trading is off-chain here; quick trade is not needed')
  const key = KeyPair.fromRandom('ed25519')
  const pk = key.getPublicKey()
  const addKey = actions.addFunctionCallAccessKey(pk, world, ['accept_offer', 'accept_bid', 'revoke_session'], 250_000_000_000_000_000_000_000n)
  const register = actions.functionCall('register_session', { public_key: pk.toString(), credit_budget: String(limits.credits), unit_budget: String(limits.units), ttl_secs: Math.round(limits.hours * 3600) }, 30_000_000_000_000n, 1_000_000_000_000_000_000_000n)
  if (session.method === 'wallet') {
    const { signTransactions } = await import('@/lib/wallet')
    await signTransactions([{ receiverId: session.account, actions: [addKey] }, { receiverId: world, actions: [register] }])
  } else if (session.method === 'near_auth') {
    // Two approvals; the relayer pays the gas for both.
    await socialRelay(session, session.account, addKey)
    await socialRelay(session, world, register)
  } else {
    throw new Error('quick trade needs a signed-in account')
  }
  try { localStorage.setItem(SK, JSON.stringify({ account: session.account, secret: key.toString(), expires: Date.now() + limits.hours * 3_600_000 } satisfies Stored)) } catch { /* private mode */ }
}

export async function disableQuickTrade(session: Session): Promise<void> {
  const key = loadSessionKey(session.account)
  cfg = cfg ?? await auth.config()
  if (key && cfg.controller) {
    // The session key signs itself out; the relayer pays.
    const acct = new Account(session.account, provider(), new KeyPairSigner(key))
    const { signedDelegate } = await acct.createSignedMetaTransaction({ receiverId: cfg.controller, actions: [actions.functionCall('revoke_session', { public_key: key.getPublicKey().toString() }, 30_000_000_000_000n, 0n)], blockHeightTtl: 120 })
    await call('/relay/delegate', { method: 'POST', body: JSON.stringify({ signed_delegate: btoa(String.fromCharCode(...encodeSignedDelegate(signedDelegate))) }) }).catch(() => {})
  }
  clearSessionKey()
}

/** Accept a quote: with the quick-trade key if one is open (no prompt), otherwise
 *  with the player's own approval. Returns the transaction hash. */
export async function acceptQuote(session: Session, call_: { receiver_id: string; method: string; args: Record<string, string>; gas: string }): Promise<{ hash: string; via: 'quick' | 'wallet' | 'social' }> {
  const action = actions.functionCall(call_.method, call_.args, BigInt(call_.gas), 0n)
  const key = loadSessionKey(session.account)
  if (key) {
    const acct = new Account(session.account, provider(), new KeyPairSigner(key))
    const r = await acct.signAndSendTransaction({ receiverId: call_.receiver_id, actions: [action], waitUntil: 'FINAL', throwOnFailure: false })
    const fail = (r.status as { Failure?: unknown }).Failure ?? r.receipts_outcome.map((x) => (x.outcome.status as { Failure?: unknown }).Failure).find(Boolean)
    if (fail) throw new Error(/session/.test(JSON.stringify(fail)) ? 'Quick trade limit reached or expired. Confirm this trade yourself, or renew quick trade.' : `trade refused: ${JSON.stringify(fail)}`)
    return { hash: r.transaction.hash, via: 'quick' }
  }
  if (session.method === 'near_auth') return { hash: await socialSendTx(session, call_.receiver_id, action), via: 'social' }
  const { signCall } = await import('@/lib/wallet')
  const { hash, result } = await signCall({ ...call_, deposit: '0' })
  if (result === 'false') throw new Error('the trade was refused; nothing moved')
  return { hash, via: 'wallet' }
}
