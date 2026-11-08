'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { accountLabel, api } from '@/lib/api'
import { displayName, useSession } from '@/lib/useSession'

export default function MainMenu() {
  const { session, loading, signOut } = useSession()
  const player = session?.account ?? null
  const world = useQuery({ queryKey: ['world'], queryFn: api.world, refetchInterval: 10_000 })
  const vanguard = world.data?.actors.find((a) => a.kind === 'faction')

  return (
    <Shell title="Main Menu">
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="OPERATOR">
          {session ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-100">{displayName(session)}</div>
                <div className="text-xs text-slate-500">
                  {session.method === 'wallet' ? `Wallet ${accountLabel(session.account)}` : `Account ${accountLabel(session.account)}`}
                </div>
              </div>
              <button className="text-sm text-slate-400 hover:text-slate-200" onClick={() => signOut()}>sign out</button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-slate-400">{loading ? 'Checking your sign-in…' : 'Sign in to take contracts and trade.'}</p>
              <Link href="/signin" className="rounded bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400">Sign in</Link>
            </div>
          )}
        </Panel>

        <Panel title="THE WORLD RIGHT NOW">
          {world.isError && <p className="text-sm text-rose-400">The economy server is not reachable ({String(world.error?.message)}).</p>}
          {world.data && vanguard && (
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Day / hour" value={`${world.data.day} · ${String(world.data.hour).padStart(2, '0')}:00`} hint={world.data.zone} />
              <Stat label="Vanguard ammo" value={vanguard.holdings.ammo} hint={`target ${vanguard.ammo_target}`} />
              <Stat label="Raid targets" value={world.data.board.length} hint={`defense L${vanguard.defense}`} />
            </div>
          )}
        </Panel>
      </div>

      <nav className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/contracts" className={`rounded-md border px-4 py-5 ${player ? 'border-cyan-600 bg-cyan-950/30 hover:bg-cyan-950/60' : 'pointer-events-none border-slate-800 opacity-40'}`}>
          <div className="font-semibold text-slate-100">Contract Board</div>
          <div className="text-sm text-slate-400">Pick a depot to raid</div>
        </Link>
        <Link href="/training" className="rounded-md border border-slate-800 px-4 py-5 hover:bg-slate-900">
          <div className="font-semibold text-slate-100">Training</div>
          <div className="text-sm text-slate-400">Practice ops, offline and unscored</div>
        </Link>
        <Link href="/exchange" className="rounded-md border border-slate-800 px-4 py-5 hover:bg-slate-900">
          <div className="font-semibold text-slate-100">Exchange</div>
          <div className="text-sm text-slate-400">Buy supplies, sell raid cargo</div>
        </Link>
        <div className="rounded-md border border-slate-800 px-4 py-5 opacity-40">
          <div className="font-semibold text-slate-100">War Room</div>
          <div className="text-sm text-slate-400">Coming next</div>
        </div>
      </nav>
    </Shell>
  )
}
