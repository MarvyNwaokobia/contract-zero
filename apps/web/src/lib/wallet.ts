// NEAR wallet sign-in through NEAR Connect (@hot-labs/near-connect): HOT, Meteor,
// Intear, MyNearWallet, Nightly and others, on testnet. The player's wallet signs
// their own trades; the game never sees a player key.
//
// Browser-only: the connector is created lazily on first use.
import type { NearConnector } from '@hot-labs/near-connect'
import { savePlayer } from '@/lib/api'

export const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet'

let connector: Promise<NearConnector> | null = null
const listeners = new Set<(account: string | null) => void>()

function emit(account: string | null) {
  for (const l of listeners) l(account)
}

function get(): Promise<NearConnector> {
  if (!connector) {
    connector = import('@hot-labs/near-connect').then(({ NearConnector }) => {
      const c = new NearConnector({ network: NETWORK, features: { signAndSendTransaction: true, testnet: NETWORK === 'testnet' } })
      c.on('wallet:signIn', (e) => {
        const id = e.accounts[0]?.accountId ?? null
        if (id) savePlayer(id)
        emit(id)
      })
      c.on('wallet:signOut', () => emit(null))
      return c
    })
  }
  return connector
}

/** Subscribe to the connected account (null when signed out). Returns an unsubscribe. */
export function onAccount(cb: (account: string | null) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** The account of an existing wallet session, if any. */
export async function restore(): Promise<string | null> {
  try {
    const { accounts } = await (await get()).getConnectedWallet()
    const id = accounts[0]?.accountId ?? null
    if (id) savePlayer(id)
    return id
  } catch {
    return null
  }
}

/** Open the wallet picker and sign in. Resolves with the account id. */
export async function connect(): Promise<string | null> {
  const c = await get()
  await c.connect()
  return restore()
}

export async function disconnect(): Promise<void> {
  const c = await get()
  await c.disconnect().catch(() => {})
  emit(null)
}

export interface ChainCall {
  receiver_id: string
  method: string
  args: Record<string, string>
  gas: string
  deposit: string
}

/** Have the player's wallet sign and send one function call. Returns the transaction
 *  hash and the decoded final result. */
export async function signCall(call: ChainCall): Promise<{ hash: string; result: string | null }> {
  const c = await get()
  const wallet = await c.wallet()
  const out = await wallet.signAndSendTransaction({
    network: NETWORK,
    receiverId: call.receiver_id,
    actions: [{ type: 'FunctionCall', params: { methodName: call.method, args: call.args, gas: call.gas, deposit: call.deposit } }],
  })
  const o = out as unknown as { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: { SuccessValue?: string } }
  const hash = o.transaction?.hash ?? o.transaction_outcome?.id ?? ''
  const sv = o.status?.SuccessValue
  return { hash, result: sv === undefined ? null : atob(sv) }
}
