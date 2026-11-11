'use client'

// The CONTRACT ZERO identity sheet: the tokens, marks and states every screen draws from.
// A development bench (see dev/layout.tsx): it exists to look at the system in one place
// and to check it by eye and by keyboard. It does not talk to the economy.

import { FactionInsignia } from '@/components/ui/FactionInsignia'
import { ICON_COLOR, ICON_LABEL, ResourceIcon, type IconKind } from '@/components/ui/ResourceIcon'
import { FACTION_COLOR } from '@/lib/factions'

const FACTIONS: { id: string; name: string; line: string }[] = [
  { id: 'vanguard', name: 'Vanguard', line: 'Disciplined military logistics, professional command.' },
  { id: 'ashen', name: 'Ashen Compact', line: 'Rugged industrial power, improvisation, aggressive survival.' },
  { id: 'vex', name: 'Vex Exchange', line: 'Opportunistic, informal wartime commerce.' },
  { id: 'halcyon', name: 'Halcyon Logistics', line: 'Polished corporate procurement and efficiency.' },
]
const SWATCH = ['ink', 'ink-2', 'panel', 'panel-2', 'line', 'line-strong', 'amber', 'amber-hi', 'steel', 'hostile', 'friendly', 'fog', 'muted', 'dim']
const KINDS: IconKind[] = ['ammo', 'med', 'fuel', 'credits']

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="cz-panel p-4"><h2 className="cz-label mb-3">{title}</h2>{children}</section>
}

export default function Identity() {
  return (
    <main className="min-h-screen bg-ink p-6 text-fog">
      <h1 className="mb-1 font-display text-3xl font-bold uppercase tracking-[0.12em]">Identity sheet</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted">Graphite, amber and steel on a dark field. Depth from inset light, one focus ring, motion on shared durations. Press Tab to see the focus ring on each control.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="Palette">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {SWATCH.map((s) => <div key={s} className="grid gap-1 text-[10px] text-muted"><div className="h-10 border border-line" style={{ background: `var(--color-${s})` }} />{s}</div>)}
          </div>
        </Block>
        <Block title="Resources">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {KINDS.map((k) => <div key={k} className="flex items-center gap-2" style={{ color: ICON_COLOR[k] }}><ResourceIcon kind={k} className="h-7 w-7" title={ICON_LABEL[k]} /><span className="text-sm text-fog">{ICON_LABEL[k]}</span></div>)}
          </div>
          <div className="mt-3 flex gap-3">{KINDS.map((k) => <span key={k} style={{ color: ICON_COLOR[k] }}><ResourceIcon kind={k} className="h-4 w-4" /></span>)}<span className="text-xs text-dim">16px, the size used beside labels</span></div>
        </Block>
        <Block title="Factions">
          <ul className="grid gap-3">
            {FACTIONS.map((f) => (
              <li key={f.id} className="flex items-center gap-3">
                <FactionInsignia id={f.id} className="h-14 w-14 shrink-0" title={f.name} />
                <FactionInsignia id={f.id} className="h-6 w-6 shrink-0" />
                <div><div className="font-display font-bold uppercase tracking-wider" style={{ color: FACTION_COLOR[f.id] }}>{f.name}</div><div className="text-xs text-muted">{f.line}</div></div>
              </li>
            ))}
            <li className="flex items-center gap-3"><FactionInsignia id="stranger" className="h-14 w-14 shrink-0" title="Unknown" /><div className="text-xs text-muted">An unknown faction gets a neutral plate, never another faction&apos;s mark.</div></li>
          </ul>
        </Block>
        <Block title="Depth">
          <div className="grid grid-cols-3 gap-3 text-center text-xs text-muted">
            <div className="cz-panel p-4">raised</div>
            <div className="cz-panel cz-panel-recessed p-4">recessed</div>
            <div className="cz-panel cz-panel-lit p-4">lit</div>
          </div>
          <p className="mt-2 text-[11px] text-dim">Panels are clipped to the cut-corner shape, which also clips outer shadows, so depth is inset light and shade.</p>
        </Block>
        <Block title="Focus and controls">
          <div className="flex flex-wrap gap-3">
            <button className="cz-btn cz-btn-primary px-5 py-2 text-sm">Primary</button>
            <button className="cz-btn cz-btn-ghost px-5 py-2 text-sm">Ghost</button>
            <button className="border border-line px-4 py-2 text-sm text-muted hover:text-fog">Plain</button>
            <a href="#identity" className="px-2 py-2 text-sm text-steel underline">Link</a>
          </div>
          <p className="mt-2 text-[11px] text-dim">The ring is drawn inside cut-corner buttons so it is never clipped. On touch screens buttons are at least 44 px tall.</p>
        </Block>
        <Block title="Motion">
          <div className="grid gap-2 text-xs text-muted">
            {(['instant', 'fast', 'base', 'slow'] as const).map((d) => (
              <div key={d} className="grid grid-cols-[5rem_1fr] items-center gap-3">
                <span>--dur-{d}</span>
                <div className="h-2 bg-line"><div className="h-2 w-1/3 bg-amber hover:w-full" style={{ transition: `width var(--dur-${d}) var(--ease-standard)` }} /></div>
              </div>
            ))}
            <p className="text-[11px] text-dim">Hover each bar. With Reduce motion on (the OS, or Settings) every duration is 0.</p>
          </div>
        </Block>
      </div>
    </main>
  )
}
