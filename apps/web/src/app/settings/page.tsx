'use client'

// The Operator Configuration Center: every setting in the game, by category.
// Graphics changes are staged and applied together (with revert); everything else
// saves and applies at once, including inside a running fight. Every control is a
// labelled native input, and the category rail is a keyboard-operable tab list.

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { TopBar } from '@/components/ui/Shell'
import { Button, Group, Note, Row, Segmented, Slider, Switch } from '@/components/settings/controls'
import { KeyBindings } from '@/components/settings/KeyBindings'
import { HowToPlayButton } from '@/components/help/HowToPlay'
import { AccountSecurity } from '@/components/settings/AccountSecurity'
import {
  ADS_SENS_RANGE, CROSSHAIR_COLORS, CROSSHAIR_SIZE_RANGE, DEFAULTS, DEFAULT_ACCESS, DEFAULT_CONTROLS, DEFAULT_GRAPHICS, DEFAULT_INTERFACE, FOV_RANGE, FPS_CAPS,
  HUD_SCALE_RANGE, PALETTES, RENDER_SCALE_RANGE, SENS_RANGE, defaultQuality, fixedTier, renderPlan, saveSettings, updateSettings, useSettings,
  type AudioMix, type Graphics, type Palette, type Quality, type Settings, type SubtitleSize,
} from '@/lib/settings'
import { bindLabel } from '@/lib/keybinds'
import { useSyncState } from '@/lib/preferencesSync'
import { resetTips } from '@/lib/tutorial'
import { FpsAudio } from '@/engine/audio'

type Cat = 'display' | 'audio' | 'controls' | 'keys' | 'interface' | 'access' | 'account'
const CATS: { id: Cat; code: string; label: string; blurb: string; icon: ReactNode }[] = [
  { id: 'display', code: '01', label: 'Display', blurb: 'Quality, resolution, frame rate and effects. Staged: apply to take effect.', icon: <><rect x="3" y="4" width="18" height="12" /><path d="M8 20h8M12 16v4" /></> },
  { id: 'audio', code: '02', label: 'Audio', blurb: 'Six channels, each live. Test plays a sample through that channel.', icon: <path d="M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /> },
  { id: 'controls', code: '03', label: 'Controls', blurb: 'Look speed, aiming and whether keys are held or pressed once.', icon: <><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 7v4" /></> },
  { id: 'keys', code: '04', label: 'Key bindings', blurb: 'Every keyboard action, two keys each, with conflicts handled.', icon: <><rect x="2" y="6" width="20" height="12" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></> },
  { id: 'interface', code: '05', label: 'Interface', blurb: 'Crosshair, HUD size, markers and feedback.', icon: <><circle cx="12" cy="12" r="7" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" /></> },
  { id: 'access', code: '06', label: 'Accessibility', blurb: 'Subtitles, motion, flashes, colour, prompts and aim assistance.', icon: <><circle cx="12" cy="5" r="2" /><path d="M5 9h14M12 9v12M8 21l4-7 4 7" /></> },
  { id: 'account', code: '07', label: 'Account & security', blurb: 'Sign-in, NEAR details, quick trade and signing out.', icon: <><rect x="5" y="10" width="14" height="10" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></> },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

export default function SettingsPage() {
  const s = useSettings()
  const set = useCallback((patch: (s: Settings) => Settings) => { updateSettings(patch) }, [])
  const [cat, setCat] = useState<Cat>('display')
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({})
  const sync = useSyncState()

  // Deep links: /settings#keys opens that category.
  useEffect(() => {
    const read = () => { const h = window.location.hash.slice(1) as Cat; if (CATS.some((c) => c.id === h)) setCat(h) }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])
  const choose = (c: Cat, focus = false) => {
    setCat(c)
    history.replaceState(null, '', `#${c}`)
    if (focus) tabs.current[c]?.focus()
  }
  const onTabKey = (e: ReactKeyboardEvent) => {
    const i = CATS.findIndex((c) => c.id === cat)
    const go = (j: number) => { e.preventDefault(); choose(CATS[(j + CATS.length) % CATS.length].id, true) }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(i + 1)
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(CATS.length - 1)
  }
  const active = CATS.find((c) => c.id === cat)!

  return (
    <main className="min-h-screen bg-ink text-fog">
      <TopBar />
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
          <div>
            <div className="font-display text-[11px] font-bold uppercase tracking-[0.34em] text-amber">Operator configuration</div>
            <h1 className="font-display text-3xl font-bold uppercase tracking-[0.12em] text-fog">Settings</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="border border-line-strong bg-ink-2 px-3 py-1 font-mono text-[11px] text-muted" data-testid="sync-chip">
              {sync.kind === 'local' ? 'STORED ON THIS DEVICE' : sync.kind === 'synced' ? 'SYNCED TO ACCOUNT' : sync.kind === 'syncing' ? 'SYNCING…' : 'SYNC FAILED · SAVED LOCALLY'}
            </span>
            <HowToPlayButton />
            <Link href="/" className="cz-label hover:text-fog">← Hub</Link>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
          {/* Category rail: a vertical tab list on desktop, a scrolling strip on phones. */}
          <nav aria-label="Settings categories" className="min-w-0">
            <div role="tablist" aria-orientation="vertical" aria-label="Settings categories" onKeyDown={onTabKey}
              className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
              {CATS.map((c) => {
                const on = c.id === cat
                return (
                  <button key={c.id} ref={(r) => { tabs.current[c.id] = r }} role="tab" id={`tab-${c.id}`} aria-selected={on} aria-controls={`panel-${c.id}`} tabIndex={on ? 0 : -1}
                    onClick={() => choose(c.id)} data-testid={`cat-${c.id}`}
                    className={`group flex shrink-0 items-center gap-3 border-l-2 px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-hi ${on ? 'border-amber bg-amber/10 text-amber-hi' : 'border-transparent text-muted hover:bg-panel hover:text-fog'}`}>
                    <span className="font-mono text-[10px] text-dim" aria-hidden>{c.code}</span>
                    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>{c.icon}</svg>
                    <span className="whitespace-nowrap font-display text-sm font-bold uppercase tracking-[0.14em]">{c.label}</span>
                  </button>
                )
              })}
            </div>
            <div className="mt-4 hidden lg:block">
              <Button testid="reset-all" onClick={() => { if (confirm('Reset every setting to its default? Your key bindings are reset too.')) saveSettings({ ...DEFAULTS, quality: s.quality }) }}>Reset everything</Button>
            </div>
          </nav>

          <section role="tabpanel" id={`panel-${cat}`} aria-labelledby={`tab-${cat}`} className="cz-panel min-w-0 p-4 sm:p-6" data-testid={`panel-${cat}`}>
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl font-bold uppercase tracking-[0.16em] text-fog">{active.label}</h2>
                <p className="mt-0.5 text-sm text-muted">{active.blurb}</p>
              </div>
              {cat !== 'account' && cat !== 'display' && cat !== 'keys' && <Button testid="reset-section" onClick={() => set((x) => resetSection(x, cat))}>Reset {active.label.toLowerCase()}</Button>}
            </div>
            {cat === 'display' && <Display s={s} />}
            {cat === 'audio' && <Audio s={s} set={set} />}
            {cat === 'controls' && <Controls s={s} set={set} />}
            {cat === 'keys' && <KeyBindings binds={s.controls.binds} onChange={(binds) => set((x) => ({ ...x, controls: { ...x.controls, binds } }))} />}
            {cat === 'interface' && <Interface s={s} set={set} />}
            {cat === 'access' && <Access s={s} set={set} />}
            {cat === 'account' && <AccountSecurity />}
            <p className="sr-only" role="status" aria-live="polite">{cat === 'display' ? '' : 'Changes save and apply immediately.'}</p>
          </section>
        </div>
        <div className="mt-6 lg:hidden">
          <Button onClick={() => { if (confirm('Reset every setting to its default? Your key bindings are reset too.')) saveSettings({ ...DEFAULTS, quality: s.quality }) }}>Reset everything</Button>
        </div>
      </div>
    </main>
  )
}

function resetSection(x: Settings, c: Cat): Settings {
  switch (c) {
    case 'audio': return { ...x, audio: DEFAULTS.audio, muteInBackground: DEFAULTS.muteInBackground }
    case 'controls': return { ...x, lookSens: 1, controls: { ...DEFAULT_CONTROLS, binds: x.controls.binds }, access: { ...x.access, toggleInteract: false } }
    case 'keys': return { ...x, controls: { ...x.controls, binds: DEFAULT_CONTROLS.binds } }
    case 'interface': return { ...x, interface: DEFAULT_INTERFACE }
    case 'access': return { ...x, subtitles: DEFAULTS.subtitles, access: { ...DEFAULT_ACCESS, toggleInteract: x.access.toggleInteract } }
    default: return x
  }
}

type SetFn = (patch: (s: Settings) => Settings) => void

// ── Display ──────────────────────────────────────────────────────────────────

const QUALITIES: { id: Quality; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Starts at High and steps down if the frame rate sags; remembers a slow machine.' },
  { id: 'high', label: 'High', hint: 'Full resolution, shadows, full post-processing.' },
  { id: 'medium', label: 'Medium', hint: 'Shadows kept, light post-processing, resolution capped at 1.5×.' },
  { id: 'low', label: 'Low', hint: 'No shadows, set dressing or post-processing; native resolution.' },
]
type Staged = { quality: Quality; graphics: Graphics }

function Display({ s }: { s: Settings }) {
  const saved: Staged = useMemo(() => ({ quality: s.quality, graphics: s.graphics }), [s.quality, s.graphics])
  const [draft, setDraft] = useState<Staged>(saved)
  const [applied, setApplied] = useState<Staged | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  // Another tab (or the pause menu) changed graphics while nothing was staged here.
  const savedKey = JSON.stringify(saved)
  useEffect(() => { if (!dirty) setDraft(saved) }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const g = draft.graphics
  const setG = (patch: Partial<Graphics>) => setDraft((d) => ({ ...d, graphics: { ...d.graphics, ...patch } }))
  const changes = dirty ? (['quality', ...Object.keys(g)] as const).filter((k) => k === 'quality' ? draft.quality !== saved.quality : draft.graphics[k as keyof Graphics] !== saved.graphics[k as keyof Graphics]).length : 0

  const apply = () => {
    if (draft.quality !== saved.quality) {
      // Choosing a tier (or Auto again) forgets what Auto had learned: it re-measures.
      try { localStorage.removeItem('cz_degraded') } catch { /* private mode */ }
    }
    setApplied(saved)
    updateSettings((x) => ({ ...x, quality: draft.quality, graphics: draft.graphics }))
  }
  const preset = draft.quality === 'auto' ? 'high' : draft.quality
  const touch = typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const plan = renderPlan(fixedTier(preset), g, touch)

  return (
    <div className="pb-16">
      <Group title="Quality">
        <Row label="Preset" hint={QUALITIES.find((q) => q.id === draft.quality)?.hint}>
          <Segmented name="quality" label="Graphics quality" value={draft.quality} onChange={(q) => setDraft((d) => ({ ...d, quality: q }))} testid="quality"
            options={QUALITIES.map((q) => ({ id: q.id, label: q.label, hint: q.hint }))} />
          <span className="text-xs text-dim">This machine’s guess: {defaultQuality()}</span>
        </Row>
        <Row label="Resolution scale" htmlFor="render-scale" hint="Share of the preset’s resolution rendered. Lower is faster and softer.">
          <Slider id="render-scale" value={g.renderScale} min={RENDER_SCALE_RANGE[0]} max={RENDER_SCALE_RANGE[1]} step={0.05} onChange={(v) => setG({ renderScale: v })} format={pct} />
        </Row>
        <Row label="Frame-rate cap" hint="Off follows your display. A cap saves battery and heat and steadies an uneven frame rate.">
          <Segmented name="fps" label="Frame-rate cap" value={g.fpsCap} onChange={(v) => setG({ fpsCap: v })} testid="fps"
            options={FPS_CAPS.map((c) => ({ id: c, label: c === 0 ? 'Off' : `${c}` }))} />
        </Row>
      </Group>
      <Group title="Effects" aside={<span className="text-[11px] text-dim">“Preset” follows the quality preset</span>}>
        <Row label="Shadows" hint="The sun’s shadow map. Off is a large saving on integrated graphics.">
          <Segmented name="shadows" label="Shadows" value={g.shadows} onChange={(v) => setG({ shadows: v })} testid="shadows"
            options={[{ id: 'preset', label: 'Preset' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} />
        </Row>
        <Row label="Post-processing" hint="Full: ambient occlusion, bloom, grain, lens edge. Light: lens edge and vignette only.">
          <Segmented name="postfx" label="Post-processing" value={g.postFx} onChange={(v) => setG({ postFx: v })} testid="postfx"
            options={[{ id: 'preset', label: 'Preset' }, { id: 'full', label: 'Full' }, { id: 'light', label: 'Light' }, { id: 'off', label: 'Off' }]} />
        </Row>
        <Row label="Set dressing" hint="Clutter props. Their collision stays either way, so cover and paths are identical.">
          <Segmented name="dressing" label="Set dressing" value={g.dressing} onChange={(v) => setG({ dressing: v })} testid="dressing"
            options={[{ id: 'preset', label: 'Preset' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} />
        </Row>
        <Row label="Particles" hint="Ambient dust and full impact debris. Off keeps lean impacts so hits still read.">
          <Segmented name="particles" label="Particles" value={g.particles} onChange={(v) => setG({ particles: v })} testid="particles"
            options={[{ id: 'preset', label: 'Preset' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} />
        </Row>
        <p className="py-2 text-xs text-dim">Lighting detail (practical lights, shader detail) follows the quality preset and has no separate switch.</p>
      </Group>
      <Group title="View">
        <Row label="Field of view" htmlFor="fov" hint="At the hip; aiming narrows from it. Applies at once.">
          <Slider id="fov" value={s.fov} min={FOV_RANGE[0]} max={FOV_RANGE[1]} step={1} onChange={(v) => updateSettings((x) => ({ ...x, fov: v }))} format={(v) => `${v}°`} valueText={(v) => `${v} degrees`} />
        </Row>
        <Fullscreen />
      </Group>
      <Group title="Performance">
        <Row label="Frame-rate readout" hint="A corner meter in the fight (also toggled by its key). Applies at once.">
          <Switch id="perf-overlay" checked={s.interface.perfOverlay} onChange={(v) => updateSettings((x) => ({ ...x, interface: { ...x.interface, perfOverlay: v } }))} label="Frame-rate readout" />
        </Row>
        <PerfInfo plan={plan} preset={draft.quality} />
      </Group>

      {/* The staging bar: what's pending, and apply or revert it. */}
      <div className="sticky bottom-0 -mx-4 mt-4 border-t border-line bg-ink/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6" data-testid="display-bar" aria-live="polite">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`flex-1 text-sm ${dirty ? 'text-amber-hi' : 'text-dim'}`} data-testid="display-pending">
            {dirty ? `${changes} pending change${changes === 1 ? '' : 's'}. Apply to use ${changes === 1 ? 'it' : 'them'}.` : applied ? 'Applied. Revert to go back to what you had.' : 'Graphics as applied.'}
          </span>
          <Button onClick={() => setDraft({ quality: DEFAULTS.quality, graphics: DEFAULT_GRAPHICS })} testid="display-defaults">Defaults</Button>
          {dirty && <Button onClick={() => setDraft(saved)} testid="display-discard">Discard</Button>}
          {!dirty && applied && <Button onClick={() => { updateSettings((x) => ({ ...x, quality: applied.quality, graphics: applied.graphics })); setApplied(null) }} testid="display-revert">Revert</Button>}
          <Button tone="primary" disabled={!dirty} onClick={apply} testid="display-apply">Apply</Button>
        </div>
      </div>
    </div>
  )
}

function Fullscreen() {
  const [on, setOn] = useState(false)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setSupported(!!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function')
    const f = () => setOn(!!document.fullscreenElement)
    f()
    document.addEventListener('fullscreenchange', f)
    return () => document.removeEventListener('fullscreenchange', f)
  }, [])
  const toggle = async () => {
    setErr(null)
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    } catch (e) {
      setErr(`The browser refused full screen${(e as Error).message ? `: ${(e as Error).message}` : ''}. Try your browser’s own full-screen key.`)
    }
  }
  return (
    <>
      <Row label="Full screen" hint="Stays on as you move between screens; Esc leaves it.">
        <Button onClick={toggle} disabled={supported === false} testid="fullscreen">{on ? 'Leave full screen' : 'Enter full screen'}</Button>
        <span className="text-xs text-dim" data-testid="fullscreen-state">{supported === false ? 'Not available in this browser' : on ? 'On' : 'Off'}</span>
      </Row>
      {supported === false && <Note testid="fullscreen-unsupported">This browser doesn’t let pages go full screen (iPhone Safari is one). Add the game to your Home Screen to play without browser bars.</Note>}
      {err && <Note tone="error" testid="fullscreen-error">{err}</Note>}
    </>
  )
}

type PerfLast = { fps: number; worstMs: number; tier: string; pixelRatio: number; shadows: boolean; post: string; cap: number; at: number }

function PerfInfo({ plan, preset }: { plan: ReturnType<typeof renderPlan>; preset: Quality }) {
  const [last, setLast] = useState<PerfLast | null>(null)
  const [dev, setDev] = useState<{ screen: string; dpr: number; cores: number | null; gpu: string | null; view: [number, number] } | null>(null)
  useEffect(() => {
    try { setLast(JSON.parse(localStorage.getItem('cz_perf_last') ?? 'null')) } catch { setLast(null) }
    let gpu: string | null = null
    try {
      const c = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
      gpu = c ? String(c.getParameter(c.RENDERER)) : null
      c?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { gpu = null }
    setDev({ screen: `${screen.width}×${screen.height}`, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency ?? null, gpu, view: [innerWidth, innerHeight] })
  }, [])
  const ratio = dev ? Math.min(plan.dprMax, Math.max(plan.dprMin, dev.dpr)) : null
  const ago = last ? Math.max(0, Math.round((Date.now() - last.at) / 60000)) : 0
  return (
    <div className="grid gap-3 py-3 md:grid-cols-2">
      <div className="border border-line bg-ink-2 p-3" data-testid="perf-last">
        <div className="mb-1 font-display text-[11px] font-bold uppercase tracking-[0.24em] text-steel">Last fight on this device</div>
        {last ? (
          <div className="font-mono text-xs leading-6 text-fog">
            <div><span className={last.fps >= 50 ? 'text-friendly' : last.fps >= 30 ? 'text-amber-hi' : 'text-[#ff8a8d]'}>{last.fps} fps</span> · worst frame {last.worstMs} ms</div>
            <div className="text-muted">{last.tier} · {last.pixelRatio}× pixels · shadows {last.shadows ? 'on' : 'off'} · post {last.post}{last.cap ? ` · cap ${last.cap}` : ''}</div>
            <div className="text-dim">{ago < 1 ? 'just now' : ago < 120 ? `${ago} min ago` : new Date(last.at).toLocaleString()}</div>
          </div>
        ) : <div className="text-xs text-dim">No fight measured yet. Deploy once and this fills in.</div>}
      </div>
      <div className="border border-line bg-ink-2 p-3" data-testid="perf-device">
        <div className="mb-1 font-display text-[11px] font-bold uppercase tracking-[0.24em] text-steel">With these settings</div>
        {dev && ratio !== null ? (
          <div className="font-mono text-xs leading-6 text-fog">
            <div>Renders ~{Math.round(dev.view[0] * ratio)}×{Math.round(dev.view[1] * ratio)} ({ratio.toFixed(2)}× of {dev.dpr}× display){preset === 'auto' ? ' to start' : ''}</div>
            <div className="text-muted">Shadows {plan.shadows ? 'on' : 'off'} · post {plan.post} · dressing {plan.dressing ? 'on' : 'off'} · particles {plan.particles ? 'on' : 'off'}</div>
            <div className="truncate text-dim" title={dev.gpu ?? undefined}>{dev.gpu ?? 'GPU unknown'} · {dev.cores ?? '?'} cores · screen {dev.screen}</div>
          </div>
        ) : <div className="text-xs text-dim">Measuring…</div>}
      </div>
    </div>
  )
}

// ── Audio ────────────────────────────────────────────────────────────────────

const MIX: { key: keyof AudioMix; label: string; hint: string }[] = [
  { key: 'master', label: 'Master', hint: 'Everything' },
  { key: 'music', label: 'Music', hint: 'The score: a drone, a pulse when you’re spotted, the theme under fire' },
  { key: 'effects', label: 'Effects', hint: 'Gunfire, impacts, explosions' },
  { key: 'voice', label: 'Voice and radio', hint: 'Briefings and radio chatter' },
  { key: 'ambience', label: 'Ambience', hint: 'Wind, room tone, refinery machinery' },
  { key: 'ui', label: 'Interface', hint: 'Pickups, beeps, reload clicks, countdowns' },
]

function Audio({ s, set }: { s: Settings; set: SetFn }) {
  const audio = useRef<FpsAudio | null>(null)
  const musicStop = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { audio.current?.dispose(); if (musicStop.current) clearTimeout(musicStop.current) }, [])
  useEffect(() => { audio.current?.setMix(s.audio) }, [s.audio])
  const test = (k: keyof AudioMix) => {
    audio.current ??= new FpsAudio()
    const a = audio.current
    a.unlock()
    if (k === 'music') {
      // A few bars of the score at combat intensity, then quiet again.
      a.setMix(s.audio)
      a.setMusicIntensity(2)
      if (musicStop.current) clearTimeout(musicStop.current)
      musicStop.current = setTimeout(() => a.setMix({ ...s.audio, music: 0 }), 6000)
      return
    }
    a.setMix({ ...s.audio, music: 0 })
    if (k === 'effects' || k === 'master') a.explosion([0, 1, -6])
    else if (k === 'voice') a.vo('dyn-settings-test', 'handler')
    else if (k === 'ambience') a.alarm(1.5)
    else a.beep(true)
  }
  return (
    <div>
      <Group title="Volume">
        {MIX.map((m) => (
          <Row key={m.key} label={m.label} htmlFor={`vol-${m.key}`} hint={m.hint}>
            <Slider id={`vol-${m.key}`} value={s.audio[m.key]} min={0} max={1} step={0.05} onChange={(v) => set((x) => ({ ...x, audio: { ...x.audio, [m.key]: v } }))} format={pct} />
            <Button onClick={() => test(m.key)} ariaLabel={`Play a ${m.label.toLowerCase()} sample`} testid={`test-${m.key}`}>Test</Button>
          </Row>
        ))}
      </Group>
      <Group title="Behaviour">
        <Row label="Mute in the background" hint="Silence the game while its tab is hidden.">
          <Switch id="mute-bg" checked={s.muteInBackground} onChange={(v) => set((x) => ({ ...x, muteInBackground: v }))} label="Mute in the background" />
        </Row>
      </Group>
      <p className="text-xs text-dim">There is no recorded dialogue: radio lines are subtitles over synthesised static, so Voice sets the static and the radio cues.</p>
    </div>
  )
}

// ── Controls ─────────────────────────────────────────────────────────────────

function Controls({ s, set }: { s: Settings; set: SetFn }) {
  const c = s.controls
  const b = c.binds
  return (
    <div>
      <Group title="Look">
        <Row label="Look sensitivity" htmlFor="sens" hint="Mouse, arrow keys and touch.">
          <Slider id="sens" value={s.lookSens} min={SENS_RANGE[0]} max={SENS_RANGE[1]} step={0.05} onChange={(v) => set((x) => ({ ...x, lookSens: v }))} format={(v) => `${v.toFixed(2)}×`} valueText={(v) => `${v.toFixed(2)} times`} />
        </Row>
        <Row label="Aiming sensitivity" htmlFor="ads-sens" hint="Multiplies look speed while aiming down sights (on top of the built-in slow-down).">
          <Slider id="ads-sens" value={c.adsSens} min={ADS_SENS_RANGE[0]} max={ADS_SENS_RANGE[1]} step={0.05} onChange={(v) => set((x) => ({ ...x, controls: { ...x.controls, adsSens: v } }))} format={(v) => `${v.toFixed(2)}×`} valueText={(v) => `${v.toFixed(2)} times`} />
        </Row>
        <Row label="Invert vertical look" hint="Mouse, arrow keys and touch drag.">
          <Switch id="invert-y" checked={c.invertY} onChange={(v) => set((x) => ({ ...x, controls: { ...x.controls, invertY: v } }))} label="Invert vertical look" />
        </Row>
      </Group>
      <Group title="Hold or press once">
        <Row label={`Aim (${bindLabel(b, 'aim')} / right mouse)`} hint="Toggle: press once to aim, again to stop.">
          <Segmented name="aim-mode" label="Aim mode" value={c.aim} onChange={(v) => set((x) => ({ ...x, controls: { ...x.controls, aim: v } }))} testid="aim-mode" options={[{ id: 'hold', label: 'Hold' }, { id: 'toggle', label: 'Toggle' }]} />
        </Row>
        <Row label={`Crouch (${bindLabel(b, 'crouch')})`} hint="Touch always uses a crouch toggle button.">
          <Segmented name="crouch-mode" label="Crouch mode" value={c.crouch} onChange={(v) => set((x) => ({ ...x, controls: { ...x.controls, crouch: v } }))} testid="crouch-mode" options={[{ id: 'hold', label: 'Hold' }, { id: 'toggle', label: 'Toggle' }]} />
        </Row>
        <Row label={`Interact (${bindLabel(b, 'interact')})`} hint="Toggle: the action runs until it completes; press again, or look away, to stop. For players who can’t hold a key.">
          <Segmented name="interact-mode" label="Interact mode" value={s.access.toggleInteract ? 'toggle' : 'hold'} onChange={(v) => set((x) => ({ ...x, access: { ...x.access, toggleInteract: v === 'toggle' } }))} testid="interact-mode" options={[{ id: 'hold', label: 'Hold' }, { id: 'toggle', label: 'Toggle' }]} />
        </Row>
      </Group>
      <Note>Not in the game, so not offered here: sprint (your speed is set by stance and the cargo you carry) and controller support. Keys are remapped under <b>Key bindings</b>.</Note>
    </div>
  )
}

// ── Interface ────────────────────────────────────────────────────────────────

function Interface({ s, set }: { s: Settings; set: SetFn }) {
  const ui = s.interface
  const [tipsReset, setTipsReset] = useState(false)
  const ch = ui.crosshair
  const setUi = (patch: Partial<Settings['interface']>) => set((x) => ({ ...x, interface: { ...x.interface, ...patch } }))
  const setCh = (patch: Partial<Settings['interface']['crosshair']>) => set((x) => ({ ...x, interface: { ...x.interface, crosshair: { ...x.interface.crosshair, ...patch } } }))
  return (
    <div>
      <Group title="Crosshair">
        <div className="grid gap-4 md:grid-cols-[1fr_11rem]">
          <div>
            <Row label="Style">
              <Segmented name="ch-style" label="Crosshair style" value={ch.style} onChange={(v) => setCh({ style: v })} testid="ch-style"
                options={[{ id: 'cross', label: 'Cross' }, { id: 'cross-dot', label: 'Cross + dot' }, { id: 'dot', label: 'Dot' }, { id: 'circle', label: 'Circle' }]} />
            </Row>
            <Row label="Colour">
              <div role="radiogroup" aria-label="Crosshair colour" className="flex flex-wrap gap-2">
                {CROSSHAIR_COLORS.map((col) => (
                  <label key={col} className={`h-7 w-7 cursor-pointer border-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-amber-hi ${ch.color === col ? 'border-fog' : 'border-transparent'}`} style={{ background: col }}>
                    <input type="radio" name="ch-color" value={col} checked={ch.color === col} onChange={() => setCh({ color: col })} className="sr-only" aria-label={COLOR_NAMES[col]} data-testid={`ch-color-${col.slice(1)}`} />
                  </label>
                ))}
              </div>
            </Row>
            <Row label="Size" htmlFor="ch-size"><Slider id="ch-size" value={ch.size} min={CROSSHAIR_SIZE_RANGE[0]} max={CROSSHAIR_SIZE_RANGE[1]} step={0.1} onChange={(v) => setCh({ size: v })} format={(v) => `${v.toFixed(1)}×`} /></Row>
            <Row label="Opacity" htmlFor="ch-opacity"><Slider id="ch-opacity" value={ch.opacity} min={0.2} max={1} step={0.05} onChange={(v) => setCh({ opacity: v })} format={pct} /></Row>
            <Row label="Spread with accuracy" hint="The cross opens as you move and fire. Off: a fixed crosshair.">
              <Switch id="ch-dynamic" checked={ch.dynamic} onChange={(v) => setCh({ dynamic: v })} label="Crosshair spreads with accuracy" />
            </Row>
          </div>
          <CrosshairPreview ch={ch} />
        </div>
      </Group>
      <Group title="HUD">
        <Row label="HUD scale" htmlFor="hud-scale" hint="Ammo, health, objective, prompts and inventory. Subtitles have their own size.">
          <Slider id="hud-scale" value={ui.hudScale} min={HUD_SCALE_RANGE[0]} max={HUD_SCALE_RANGE[1]} step={0.05} onChange={(v) => setUi({ hudScale: v })} format={pct} />
        </Row>
        <Row label="Objective arrow" hint="The edge arrow toward the objective or extraction when it’s off screen. The objective line stays either way.">
          <Switch id="obj-arrow" checked={ui.objectiveArrow} onChange={(v) => setUi({ objectiveArrow: v })} label="Objective arrow" />
        </Row>
        <Row label="First-time tips" hint="One short line, the first time you fight, pick something up, carry cargo, extract and finish a contract. Never covers the fight; fades on its own.">
          <Switch id="tips" checked={ui.tips} onChange={(v) => setUi({ tips: v })} label="First-time tips" />
          <Button onClick={() => { resetTips(); setTipsReset(true) }} testid="tips-reset">{tipsReset ? 'Will show again' : 'Replay tips'}</Button>
        </Row>
        <Row label="Interaction hints" hint={`The second line under a prompt (“${bindLabel(s.controls.binds, 'inspect')} · INSPECT”).`}>
          <Switch id="prompt-hints" checked={ui.promptHints} onChange={(v) => setUi({ promptHints: v })} label="Interaction hints" />
        </Row>
      </Group>
      <Group title="Combat feedback">
        <Row label="Hit markers" hint="The ✕ on a hit. The hit sound plays either way.">
          <Switch id="hit-markers" checked={ui.hitMarkers} onChange={(v) => setUi({ hitMarkers: v })} label="Hit markers" />
        </Row>
        <Row label="Damage direction" hint="The arc showing where a shot that hit you came from.">
          <Switch id="damage-dir" checked={ui.damageDirection} onChange={(v) => setUi({ damageDirection: v })} label="Damage direction" />
        </Row>
        <Row label="Threat arrows" hint="Edge arrows for enemies aiming or firing at you from off screen.">
          <Switch id="threat-arrows" checked={ui.threatArrows} onChange={(v) => setUi({ threatArrows: v })} label="Threat arrows" />
        </Row>
      </Group>
    </div>
  )
}

const COLOR_NAMES: Record<string, string> = { '#e9edf2': 'White', '#5fe0a8': 'Green', '#f0e442': 'Yellow', '#37d0e0': 'Cyan', '#ff6ad5': 'Magenta', '#ffb454': 'Orange' }

function CrosshairPreview({ ch }: { ch: Settings['interface']['crosshair'] }) {
  const L = Math.round(8 * ch.size), W = Math.max(2, Math.round(2 * ch.size)), gap = Math.round(9 * ch.size)
  const tick = (x: number, y: number, w: number, h: number) => <div style={{ position: 'absolute', left: '50%', top: '50%', width: w, height: h, transform: `translate(${x}px, ${y}px)`, background: ch.color, opacity: ch.opacity, boxShadow: '0 0 2px #000' }} />
  const showTicks = ch.style === 'cross' || ch.style === 'cross-dot'
  const dot = ch.style === 'cross' ? 2 : Math.max(3, Math.round(4 * ch.size))
  return (
    <div className="relative h-44 overflow-hidden border border-line bg-[radial-gradient(circle_at_50%_40%,#3a3f45,#14171b)]" aria-label="Crosshair preview" role="img" data-testid="ch-preview">
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-[#2a2722]" aria-hidden />
      {showTicks && <>{tick(-W / 2, -gap - L, W, L)}{tick(-W / 2, gap, W, L)}{tick(-gap - L, -W / 2, L, W)}{tick(gap, -W / 2, L, W)}</>}
      {ch.style === 'circle' && <div style={{ position: 'absolute', left: '50%', top: '50%', width: (gap + L / 2) * 2, height: (gap + L / 2) * 2, transform: 'translate(-50%,-50%)', border: `2px solid ${ch.color}`, borderRadius: '50%', opacity: ch.opacity }} />}
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: dot, height: dot, transform: 'translate(-50%,-50%)', background: ch.color, opacity: ch.opacity, borderRadius: ch.style === 'cross' ? 0 : '50%' }} />
    </div>
  )
}

// ── Accessibility ────────────────────────────────────────────────────────────

function Access({ s, set }: { s: Settings; set: SetFn }) {
  const a = s.access
  const setA = (patch: Partial<Settings['access']>) => set((x) => ({ ...x, access: { ...x.access, ...patch } }))
  const subPx = s.subtitles.size === 's' ? 13 : s.subtitles.size === 'l' ? 21 : 16
  return (
    <div>
      <Group title="Subtitles">
        <Row label="Radio and briefing subtitles" hint="The radio still plays with subtitles off.">
          <Switch id="subs-on" checked={s.subtitles.on} onChange={(v) => set((x) => ({ ...x, subtitles: { ...x.subtitles, on: v } }))} label="Subtitles" />
        </Row>
        <Row label="Size">
          <Segmented name="subsize" label="Subtitle size" value={s.subtitles.size} onChange={(v: SubtitleSize) => set((x) => ({ ...x, subtitles: { ...x.subtitles, size: v } }))} testid="subsize" options={[{ id: 's', label: 'Small' }, { id: 'm', label: 'Medium' }, { id: 'l', label: 'Large' }]} />
        </Row>
        <Row label="Background" htmlFor="subs-bg" hint="A dark box behind the text.">
          <Slider id="subs-bg" value={s.subtitles.background} min={0} max={1} step={0.05} onChange={(v) => set((x) => ({ ...x, subtitles: { ...x.subtitles, background: v } }))} format={pct} />
        </Row>
        <Row label="Colour speaker names" hint="Off: every name in white.">
          <Switch id="subs-color" checked={s.subtitles.speakerColors} onChange={(v) => set((x) => ({ ...x, subtitles: { ...x.subtitles, speakerColors: v } }))} label="Colour speaker names" />
        </Row>
        <div className="my-2 flex justify-center border border-line bg-[#20262c] p-6" aria-hidden data-testid="subs-preview">
          <div style={{ textAlign: 'center', background: `rgba(0,0,0,${s.subtitles.background})`, padding: s.subtitles.background > 0 ? '8px 14px' : 0, borderRadius: 6, opacity: s.subtitles.on ? 1 : 0.25 }}>
            <div style={{ fontSize: Math.round(subPx * 0.72), letterSpacing: 3, fontWeight: 700, color: s.subtitles.speakerColors ? '#8fd6e8' : '#e9edf2' }}>KESTREL</div>
            <div style={{ fontSize: subPx, lineHeight: 1.5, color: '#e9edf2', textShadow: '0 0 8px #000' }}>That’s the yard. Get on the cargo.</div>
          </div>
        </div>
      </Group>
      <Group title="Comfort">
        <Row label="Reduce motion" hint="No camera shake, head bob or weapon sway; gentler hit reactions. Follows your system setting until you choose.">
          <Switch id="reduce-motion" checked={a.reduceMotion} onChange={(v) => setA({ reduceMotion: v })} label="Reduce motion" />
        </Row>
        <Row label="Reduce flashes" hint="No full-screen hit flash or blast fireball, steady flares and fire, and a much dimmer muzzle light.">
          <Switch id="reduce-flashes" checked={a.reduceFlashes} onChange={(v) => setA({ reduceFlashes: v })} label="Reduce flashes" />
        </Row>
      </Group>
      <Group title="Colour and contrast">
        <Row label="Colour palette" hint="For hostile, objective, success and health colours. Every one is also labelled in text.">
          <Segmented name="palette" label="Colour palette" value={a.palette} onChange={(v: Palette) => setA({ palette: v })} testid="palette"
            options={[{ id: 'standard', label: 'Standard' }, { id: 'redgreen', label: 'Red–green safe' }, { id: 'tritan', label: 'Blue–yellow safe' }]} />
        </Row>
        <div className="mb-2 flex flex-wrap gap-2 py-1" data-testid="palette-preview">
          {(['hostile', 'objective', 'success'] as const).map((k) => (
            <span key={k} className="inline-flex items-center gap-2 border border-line bg-ink-2 px-2.5 py-1 font-display text-xs font-bold uppercase tracking-[0.16em]" style={{ color: PALETTES[a.palette][k] }}>
              <span className="h-2.5 w-2.5" style={{ background: PALETTES[a.palette][k] }} aria-hidden />{k === 'hostile' ? 'Hostile' : k === 'objective' ? 'Objective' : 'Extract'}
            </span>
          ))}
          <span className="inline-flex items-center gap-2 border border-line bg-ink-2 px-2.5 py-1 font-display text-xs font-bold uppercase tracking-[0.16em] text-muted">
            Health <span className="inline-block h-2 w-16" style={{ background: `linear-gradient(90deg, ${PALETTES[a.palette].healthLo}, #ffb454, ${PALETTES[a.palette].healthHi})` }} aria-hidden />
          </span>
        </div>
        <Row label="High-contrast prompts" hint="Interaction prompts on a solid black panel with a white key cap and heavier text.">
          <Switch id="hc-prompts" checked={a.highContrastPrompts} onChange={(v) => setA({ highContrastPrompts: v })} label="High-contrast prompts" />
        </Row>
        <PromptPreview hc={a.highContrastPrompts} keyName={bindLabel(s.controls.binds, 'interact')} inspect={s.interface.promptHints ? bindLabel(s.controls.binds, 'inspect') : null} />
      </Group>
      <Group title="Assistance">
        <Row label="Aim assist" hint="A gentle pull onto a visible enemy while you fire or aim. You still choose who; it helps with the fine aim. PvE only, so it affects no other player.">
          <Segmented name="aim-assist" label="Aim assist" value={a.aimAssist} onChange={(v) => setA({ aimAssist: v })} testid="aim-assist" options={[{ id: 'touch', label: 'Touch only' }, { id: 'always', label: 'Always' }, { id: 'off', label: 'Off' }]} />
        </Row>
        <Row label={`Target lock (${bindLabel(s.controls.binds, 'target')})`} hint="Snaps onto the nearest visible enemy; press again to cycle. Moving the mouse releases it. On touch: the Target button and tap-to-target.">
          <Switch id="target-lock" checked={a.targetLock} onChange={(v) => setA({ targetLock: v })} label="Target lock" />
        </Row>
        <p className="py-2 text-xs text-dim">Assistance changes how you aim, never what the server credits: every pickup, kill and extraction is still checked the same way.</p>
      </Group>
    </div>
  )
}

function PromptPreview({ hc, keyName, inspect }: { hc: boolean; keyName: string; inspect: string | null }) {
  return (
    <div className="my-2 flex justify-center border border-line bg-[radial-gradient(circle_at_50%_40%,#4a4f55,#1c1f23)] p-6" aria-hidden data-testid="prompt-preview">
      <div style={hc ? { background: '#000', border: '2px solid #fff', borderRadius: 8, padding: '8px 14px', textAlign: 'center' } : { textAlign: 'center', textShadow: '0 0 6px #000' }}>
        <div style={{ fontSize: hc ? 17 : 15, letterSpacing: 2, color: '#fff', fontWeight: hc ? 800 : 400 }}>
          <span style={hc ? { display: 'inline-block', minWidth: 26, padding: '2px 8px', marginRight: 10, background: '#fff', color: '#000', borderRadius: 4, fontWeight: 900 } : { display: 'inline-block', minWidth: 22, padding: '1px 6px', marginRight: 8, border: '1px solid #e9edf2', borderRadius: 4, fontWeight: 800 }}>{keyName}</span>
          SECURE AMMUNITION CASE
        </div>
        {inspect && <div style={{ marginTop: 3, fontSize: hc ? 13 : 11, letterSpacing: 2, color: hc ? '#fff' : '#8a97a3' }}>{inspect} · INSPECT</div>}
      </div>
    </div>
  )
}
