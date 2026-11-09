'use client'

// The pause menu's settings: what a player tunes mid-fight, live, without leaving it.
// Leaving a contract abandons it, so "All settings" opens the full Configuration
// Center in a new tab; changes there reach this fight through the storage event.

import { useState, type CSSProperties, type ReactNode } from 'react'
import { HowToPlayButton } from '@/components/help/HowToPlay'
import { ADS_SENS_RANGE, FOV_RANGE, HUD_SCALE_RANGE, SENS_RANGE, updateSettings, type AudioMix, type Quality, type Settings } from '@/lib/settings'

const C = { accent: '#37d0e0', dim: '#6f7d8c', text: '#e9edf2', line: 'rgba(255,255,255,.08)' }
type Tab = 'view' | 'audio' | 'controls' | 'comfort'

export function PauseSettings({ s, onQuality, touch }: { s: Settings; onQuality: (q: Quality) => void; touch: boolean }) {
  const [tab, setTab] = useState<Tab>('view')
  const set = (f: (x: Settings) => Settings) => updateSettings(f)
  return (
    <div style={{ width: 'min(92vw, 520px)', marginTop: 20, border: `1px solid ${C.line}`, background: 'rgba(10,16,22,.75)' }} data-testid="pause-settings">
      <div role="tablist" aria-label="Quick settings" style={{ display: 'flex', borderBottom: `1px solid ${C.line}` }}>
        {(['view', 'audio', 'controls', 'comfort'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`pause-tab-${t}`}
            style={{ flex: 1, padding: '9px 4px', fontSize: 11, letterSpacing: 2, fontWeight: 700, color: tab === t ? C.accent : C.dim, background: tab === t ? 'rgba(55,208,224,.1)' : 'transparent', borderBottom: `2px solid ${tab === t ? C.accent : 'transparent'}`, cursor: 'pointer' }}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      <div role="tabpanel" style={{ padding: '10px 14px', maxHeight: '38vh', overflowY: 'auto' }}>
        {tab === 'view' && <>
          <Line label="GRAPHICS">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['auto', 'high', 'medium', 'low'] as const).map((q) => (
                <button key={q} onClick={() => onQuality(q)} aria-pressed={s.quality === q} data-testid={`pause-quality-${q}`}
                  style={{ padding: '4px 10px', fontSize: 11, letterSpacing: 1, cursor: 'pointer', border: `1px solid ${s.quality === q ? C.accent : '#3a4550'}`, color: s.quality === q ? C.accent : '#9fb4c8', background: s.quality === q ? 'rgba(55,208,224,.14)' : 'transparent' }}>{q.toUpperCase()}</button>
              ))}
            </div>
          </Line>
          <Range label="FIELD OF VIEW" id="p-fov" v={s.fov} min={FOV_RANGE[0]} max={FOV_RANGE[1]} step={1} fmt={(v) => `${v}°`} on={(v) => set((x) => ({ ...x, fov: v }))} />
          <Range label="HUD SCALE" id="p-hud" v={s.interface.hudScale} min={HUD_SCALE_RANGE[0]} max={HUD_SCALE_RANGE[1]} step={0.05} fmt={pct} on={(v) => set((x) => ({ ...x, interface: { ...x.interface, hudScale: v } }))} />
          <Line label="CROSSHAIR">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['cross', 'cross-dot', 'dot', 'circle'] as const).map((st) => (
                <button key={st} onClick={() => set((x) => ({ ...x, interface: { ...x.interface, crosshair: { ...x.interface.crosshair, style: st } } }))} aria-pressed={s.interface.crosshair.style === st}
                  style={{ padding: '4px 8px', fontSize: 10, letterSpacing: 1, cursor: 'pointer', border: `1px solid ${s.interface.crosshair.style === st ? C.accent : '#3a4550'}`, color: s.interface.crosshair.style === st ? C.accent : '#9fb4c8', background: 'transparent' }}>{st.replace('-', ' + ').toUpperCase()}</button>
              ))}
            </div>
          </Line>
          <Check label="FRAME-RATE READOUT" id="p-perf" v={s.interface.perfOverlay} on={(v) => set((x) => ({ ...x, interface: { ...x.interface, perfOverlay: v } }))} />
        </>}
        {tab === 'audio' && (['master', 'music', 'effects', 'voice', 'ambience'] as (keyof AudioMix)[]).map((k) => (
          <Range key={k} label={k === 'voice' ? 'VOICE / RADIO' : k.toUpperCase()} id={`p-vol-${k}`} v={s.audio[k]} min={0} max={1} step={0.05} fmt={pct} on={(v) => set((x) => ({ ...x, audio: { ...x.audio, [k]: v } }))} />
        ))}
        {tab === 'controls' && <>
          <Range label={touch ? 'AIM SPEED' : 'MOUSE SPEED'} id="p-sens" v={s.lookSens} min={SENS_RANGE[0]} max={SENS_RANGE[1]} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} on={(v) => set((x) => ({ ...x, lookSens: v }))} />
          <Range label="AIMING SPEED" id="p-ads" v={s.controls.adsSens} min={ADS_SENS_RANGE[0]} max={ADS_SENS_RANGE[1]} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} on={(v) => set((x) => ({ ...x, controls: { ...x.controls, adsSens: v } }))} />
          <Check label="INVERT VERTICAL LOOK" id="p-invert" v={s.controls.invertY} on={(v) => set((x) => ({ ...x, controls: { ...x.controls, invertY: v } }))} />
          {!touch && <Check label="AIM: PRESS ONCE (TOGGLE)" id="p-aim" v={s.controls.aim === 'toggle'} on={(v) => set((x) => ({ ...x, controls: { ...x.controls, aim: v ? 'toggle' : 'hold' } }))} />}
          {!touch && <Check label="CROUCH: PRESS ONCE (TOGGLE)" id="p-crouch" v={s.controls.crouch === 'toggle'} on={(v) => set((x) => ({ ...x, controls: { ...x.controls, crouch: v ? 'toggle' : 'hold' } }))} />}
          <Check label="INTERACT: PRESS ONCE (TOGGLE)" id="p-interact" v={s.access.toggleInteract} on={(v) => set((x) => ({ ...x, access: { ...x.access, toggleInteract: v } }))} />
        </>}
        {tab === 'comfort' && <>
          <Check label="SUBTITLES" id="p-subs" v={s.subtitles.on} on={(v) => set((x) => ({ ...x, subtitles: { ...x.subtitles, on: v } }))} />
          <Check label="REDUCE MOTION" id="p-motion" v={s.access.reduceMotion} on={(v) => set((x) => ({ ...x, access: { ...x.access, reduceMotion: v } }))} />
          <Check label="REDUCE FLASHES" id="p-flashes" v={s.access.reduceFlashes} on={(v) => set((x) => ({ ...x, access: { ...x.access, reduceFlashes: v } }))} />
          <Check label="HIGH-CONTRAST PROMPTS" id="p-hc" v={s.access.highContrastPrompts} on={(v) => set((x) => ({ ...x, access: { ...x.access, highContrastPrompts: v } }))} />
          <Line label="COLOURS">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {([['standard', 'STANDARD'], ['redgreen', 'RED–GREEN SAFE'], ['tritan', 'BLUE–YELLOW SAFE']] as const).map(([id, l]) => (
                <button key={id} onClick={() => set((x) => ({ ...x, access: { ...x.access, palette: id } }))} aria-pressed={s.access.palette === id}
                  style={{ padding: '4px 8px', fontSize: 10, letterSpacing: 1, cursor: 'pointer', border: `1px solid ${s.access.palette === id ? C.accent : '#3a4550'}`, color: s.access.palette === id ? C.accent : '#9fb4c8', background: 'transparent' }}>{l}</button>
              ))}
            </div>
          </Line>
        </>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderTop: `1px solid ${C.line}`, fontSize: 10, letterSpacing: 1.5, color: C.dim }}>
        <HowToPlayButton label="HOW TO PLAY" className="font-bold tracking-[2px] text-[#37d0e0] underline" />
        <a href="/settings" target="_blank" rel="noopener" style={{ color: C.accent, letterSpacing: 2, fontWeight: 700 }} data-testid="pause-all-settings">ALL SETTINGS ↗</a>
      </div>
    </div>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const labelStyle: CSSProperties = { fontSize: 10, letterSpacing: 2, color: C.dim, width: 150, flexShrink: 0 }

function Line({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}><span style={labelStyle}>{label}</span>{children}</div>
}

function Range({ label, id, v, min, max, step, fmt, on }: { label: string; id: string; v: number; min: number; max: number; step: number; fmt: (v: number) => string; on: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.line}` }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.currentTarget.value))} aria-valuetext={fmt(v)} data-testid={id}
        style={{ flex: 1, minWidth: 0, accentColor: C.accent, height: 24, cursor: 'pointer', touchAction: 'none' }} />
      <span style={{ width: 44, textAlign: 'right', fontSize: 11, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</span>
    </div>
  )
}

function Check({ label, id, v, on }: { label: string; id: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.line}` }}>
      <label htmlFor={id} style={{ ...labelStyle, width: 'auto', flex: 1, cursor: 'pointer' }}>{label}</label>
      <input id={id} type="checkbox" role="switch" checked={v} onChange={(e) => on(e.currentTarget.checked)} data-testid={id} style={{ width: 18, height: 18, accentColor: C.accent, cursor: 'pointer' }} />
    </div>
  )
}
