'use client'

// How to Play: the essentials in five short tabs, reachable from the Hub, Training,
// contract intel, Settings and the pause menu. Controls come from lib/controls (the
// same definition the docs are generated from) with the player's own key bindings.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { desktopControls, FIELD_RULES, TOUCH_CONTROLS } from '@/lib/controls'
import { useSettings } from '@/lib/settings'
import { resetTips } from '@/lib/tutorial'
import { KeyboardDiagram, TouchDiagram } from './ControlDiagrams'

export const PLAYER_GUIDE_URL = 'https://github.com/Psalmuel01/contract-zero/blob/main/docs/PLAYER_GUIDE.md'

type Tab = 'basics' | 'desktop' | 'touch' | 'missions' | 'world'
const TABS: { id: Tab; label: string }[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'desktop', label: 'Keyboard & mouse' },
  { id: 'touch', label: 'Touch' },
  { id: 'missions', label: 'Missions' },
  { id: 'world', label: 'The world' },
]

export function HowToPlayButton({ className = '', label = 'How to play', initial }: { className?: string; label?: string; initial?: Tab }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className || 'cz-btn cz-btn-ghost px-4 py-1.5 text-xs'} data-testid="how-to-play">{label}</button>
      {open && <HowToPlay onClose={() => setOpen(false)} initial={initial} />}
    </>
  )
}

export function HowToPlay({ onClose, initial }: { onClose: () => void; initial?: Tab }) {
  const s = useSettings()
  const touch = typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const [tab, setTab] = useState<Tab>(initial === 'desktop' && touch ? 'touch' : initial ?? (touch ? 'touch' : 'basics'))
  const [reset, setReset] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus()
    // While open, the manual owns the keyboard: nothing reaches the briefing (Enter,
    // Space) or the game (movement, fire). Default actions inside the dialog still work.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.() }
  }, [onClose])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[200] grid place-items-center bg-ink/80 p-3 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="htp-title" className="cz-panel flex max-h-[92vh] w-full max-w-3xl flex-col text-fog" data-testid="how-to-play-dialog">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 id="htp-title" className="font-display text-lg font-bold uppercase tracking-[0.16em]">Field manual</h2>
          <a href={PLAYER_GUIDE_URL} target="_blank" rel="noreferrer noopener" className="text-xs text-steel underline">Full guide ↗</a>
          <button onClick={onClose} className="ml-auto cz-label hover:text-fog" aria-label="Close how to play">Close · Esc</button>
        </div>
        <div role="tablist" aria-label="How to play sections" className="flex gap-1 overflow-x-auto border-b border-line px-2">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} data-testid={`htp-${t.id}`}
              className={`shrink-0 border-b-2 px-3 py-2 font-display text-xs font-bold uppercase tracking-[0.14em] ${tab === t.id ? 'border-amber text-amber-hi' : 'border-transparent text-muted hover:text-fog'}`}>{t.label}</button>
          ))}
        </div>
        <div role="tabpanel" className="min-h-0 overflow-y-auto p-4 text-sm leading-relaxed">
          {tab === 'basics' && <Basics />}
          {tab === 'desktop' && <><KeyboardDiagram binds={s.controls.binds} /><ControlsTable groups={desktopControls(s.controls.binds)} /></>}
          {tab === 'touch' && <><TouchDiagram /><ControlsTable groups={[{ group: 'Touch', rows: TOUCH_CONTROLS }]} touchNote /></>}
          {tab === 'missions' && <Missions />}
          {tab === 'world' && <World />}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 text-xs text-dim">
          <span>First-time tips appear in the field and fade on their own.</span>
          <button className="ml-auto text-amber-hi underline" onClick={() => { resetTips(); setReset(true) }} data-testid="htp-reset-tips">{reset ? 'Tips will show again' : 'Show tips again'}</button>
          <a href="/settings#keys" className="text-steel underline">Change keys</a>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function H({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 mt-4 font-display text-xs font-bold uppercase tracking-[0.24em] text-steel first:mt-0">{children}</h3>
}

function Basics() {
  return (
    <>
      <H>The loop</H>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fog">
        {['Take a contract', 'Read the intel', 'Pick a loadout', 'Fight or slip past', 'Secure the objective', 'Extract', 'The world reacts'].map((x, i, a) => (
          <li key={x} className="flex items-center gap-2"><span className="bg-amber/15 px-2 py-0.5 text-amber-hi">{x}</span>{i < a.length - 1 && <span className="text-dim" aria-hidden>→</span>}</li>
        ))}
      </ol>
      <p className="mt-2 text-muted">Factions hold real stock. Take a faction&apos;s ammunition and its next guards carry less; its commander may buy more, and two merchants compete to sell it. That is why the next contract is different.</p>
      <H>Field rules</H>
      <ul className="list-disc space-y-1 pl-5 text-muted">{FIELD_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
      <H>First time?</H>
      <p className="text-muted">Start in <a href="/training" className="text-steel underline">Training → Practice</a>: Dustline Depot, day, raid, L1. Nothing there is scored, so you can learn to extract without risk.</p>
    </>
  )
}

function ControlsTable({ groups, touchNote }: { groups: { group: string; rows: { action: string; keys: string; note?: string }[] }[]; touchNote?: boolean }) {
  return (
    <>
      {touchNote && <p className="mb-3 text-muted">One thumb moves, the other aims and fires. ADS and crouch are toggles on touch, so you never need a third thumb. Play in landscape.</p>}
      {groups.map((g) => (
        <section key={g.group}>
          <H>{g.group}</H>
          <table className="w-full text-left">
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.action} className="border-b border-line/60 align-top">
                  <th scope="row" className="py-1.5 pr-3 font-normal text-fog">{r.action}</th>
                  <td className="py-1.5 pr-3 font-mono text-xs text-amber-hi">{r.keys}</td>
                  <td className="hidden py-1.5 text-xs text-dim sm:table-cell">{r.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  )
}

function Missions() {
  return (
    <>
      <H>Raid</H>
      <p className="text-muted">Reach the depot, hold the use key on cargo cases (25 units each, up to 3 carried), carry them to the extraction zone and hold it for 8 seconds. Only what you carry out is paid; a bounty needs at least half the manifest.</p>
      <H>Sabotage</H>
      <p className="text-muted">Plant charges on two targets (5 seconds each). The second lights a 12-second fuse: get clear of the 7 m blast. The faction loses stock and the line stops producing for 36 hours; you are paid a fee.</p>
      <H>Recovery</H>
      <p className="text-muted">Free the seized case (it is heavy: about 20% slower), carry it to the handover vehicle and signal it. The cargo goes home to its owner; you are paid a fee.</p>
      <H>Day, dusk, night</H>
      <p className="text-muted">The world clock runs an in-game hour per real minute. Day: guards see 30 m. Dusk: 26 m, reinforcements come faster. Night: 20 m, worse aim, slower reinforcements, and night vision is issued. The site stays the same; the conditions change.</p>
      <H>Modes</H>
      <p className="text-muted"><b className="text-fog">Live contracts</b> (Contracts) change the economy and settle on NEAR. <b className="text-fog">Training</b>: a 15-operation campaign (plus the Kill-House and, once the campaign is done, the Gauntlet), <b className="text-fog">Practice</b> (any site, hour, operation and difficulty) and <b className="text-fog">Endless</b> (rooms until you fall). Training modes are unscored.</p>
    </>
  )
}

function World() {
  return (
    <>
      <H>What things are</H>
      <p className="text-muted">Credits pay for everything. Ammunition arms guards, medicine brings reinforcements, fuel moves supplies. They are tokens on NEAR testnet, and so are guns you own. Credits are game currency, not NEAR.</p>
      <H>Who acts</H>
      <p className="text-muted">Vanguard and the Ashen Compact are factions with treasuries and stock; Vex Exchange and Halcyon Logistics are merchants. When a faction runs short it posts a supply order, and both merchants compete to fill it. They act on their own, every in-game hour.</p>
      <H>Where to look</H>
      <p className="text-muted"><b className="text-fog">Exchange</b>: sell your haul, buy supplies, or place your own supply order and take the best offer. <b className="text-fog">War Room</b>: why the world changed, from your raid to the faction&apos;s order to the next mission&apos;s guards, with every NEAR transaction. Only “Settled on NEAR” means a confirmed transaction.</p>
    </>
  )
}
