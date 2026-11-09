'use client'

// Settings: graphics, audio, subtitles, controls and accessibility. Every control is
// a labelled native input (keyboard and screen-reader operable), changes save and
// apply at once, including inside a running fight.

import { useEffect, useRef, type ReactNode } from 'react'
import { Panel, Shell } from '@/components/ui/Shell'
import { DEFAULTS, FOV_RANGE, SENS_RANGE, defaultQuality, saveSettings, updateSettings, useSettings, type AudioMix, type Quality, type Settings, type SubtitleSize } from '@/lib/settings'
import { FpsAudio } from '@/engine/audio'

const QUALITIES: { id: Quality; label: string; note: string }[] = [
  { id: 'auto', label: 'Auto', note: 'Starts full and steps down by itself if the frame rate sags; remembers a slow machine.' },
  { id: 'high', label: 'High', note: 'Dedicated graphics: full resolution, shadows, post-processing, dense atmosphere.' },
  { id: 'medium', label: 'Medium', note: 'Most laptops: shadows kept, heavy post-processing off, resolution capped at 1.5×.' },
  { id: 'low', label: 'Low', note: 'Integrated graphics: no shadows or set dressing, lean effects, native resolution.' },
]

const MIX: { key: keyof AudioMix; label: string; hint: string }[] = [
  { key: 'master', label: 'Master', hint: 'Everything' },
  { key: 'effects', label: 'Effects', hint: 'Gunfire, impacts, explosions' },
  { key: 'voice', label: 'Voice and radio', hint: 'Briefings and radio chatter' },
  { key: 'ambience', label: 'Ambience', hint: 'Wind, room tone, refinery machinery' },
  { key: 'ui', label: 'Interface', hint: 'Pickups, beeps, reload clicks, countdowns' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`
const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber'

function Row({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-x-4 gap-y-1 py-2 sm:grid-cols-[13rem_1fr]">
      <div>
        <label htmlFor={htmlFor} className="text-sm font-semibold text-fog">{label}</label>
        {hint && <div className="text-xs text-dim">{hint}</div>}
      </div>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  )
}

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} className={`mt-1 h-5 w-5 accent-amber ${focus}`} data-testid={id} />
      <div>
        <label htmlFor={id} className="text-sm font-semibold text-fog">{label}</label>
        {hint && <div className="text-xs text-dim">{hint}</div>}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const s = useSettings()
  const set = (patch: (s: Settings) => Settings) => updateSettings(patch)
  // A local voice for the test buttons, playing through the same mix as the game.
  const audio = useRef<FpsAudio | null>(null)
  useEffect(() => () => audio.current?.dispose(), [])
  useEffect(() => { audio.current?.setMix(s.audio) }, [s.audio])
  const test = (k: keyof AudioMix) => {
    audio.current ??= new FpsAudio()
    audio.current.unlock()
    audio.current.setMix(s.audio)
    if (k === 'effects' || k === 'master') audio.current.explosion([0, 1, -6])
    else if (k === 'voice') audio.current.vo('dyn-settings-test', 'handler')
    else if (k === 'ambience') audio.current.alarm(1.5)
    else audio.current.beep(true)
  }

  return (
    <Shell title="Settings" back={{ href: '/', label: 'Hub' }}>
      <p className="mb-4 text-sm text-muted" role="status" aria-live="polite">Changes save and apply immediately, including during a fight.</p>

      <Panel title="Graphics">
        <fieldset>
          <legend className="sr-only">Graphics quality</legend>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Graphics quality">
            {QUALITIES.map((q) => (
              <label key={q.id} className={`cz-panel cursor-pointer p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-amber-hi ${s.quality === q.id ? 'outline-1 outline-amber' : 'opacity-80 hover:opacity-100'}`} style={{ outlineStyle: s.quality === q.id ? 'solid' : undefined }}>
                <input type="radio" name="quality" value={q.id} checked={s.quality === q.id} onChange={() => set((x) => ({ ...x, quality: q.id }))} className={`sr-only`} data-testid={`quality-${q.id}`} />
                <div className="font-display text-lg font-bold uppercase tracking-wider">{q.label}{q.id === 'auto' && <span className="ml-2 text-xs normal-case text-muted">recommended</span>}{q.id === defaultQuality() && <span className="ml-2 text-xs normal-case text-dim">this machine’s guess</span>}</div>
                <div className="mt-1 text-xs text-muted">{q.note}</div>
              </label>
            ))}
          </div>
        </fieldset>
        <Row label="Field of view" htmlFor="fov" hint="At the hip; aiming narrows it">
          <input id="fov" type="range" min={FOV_RANGE[0]} max={FOV_RANGE[1]} step={1} value={s.fov} onChange={(e) => set((x) => ({ ...x, fov: Number(e.currentTarget.value) }))} className={`flex-1 accent-amber ${focus}`} aria-valuetext={`${s.fov} degrees`} data-testid="fov" />
          <span className="w-12 text-right text-sm tabular-nums text-fog">{s.fov}°</span>
        </Row>
      </Panel>

      <Panel title="Audio" className="mt-4">
        {MIX.map((m) => (
          <Row key={m.key} label={m.label} htmlFor={`vol-${m.key}`} hint={m.hint}>
            <input id={`vol-${m.key}`} type="range" min={0} max={1} step={0.05} value={s.audio[m.key]} onChange={(e) => { const v = Number(e.currentTarget.value); set((x) => ({ ...x, audio: { ...x.audio, [m.key]: v } })) }} className={`flex-1 accent-amber ${focus}`} aria-valuetext={pct(s.audio[m.key])} data-testid={`vol-${m.key}`} />
            <span className="w-12 text-right text-sm tabular-nums text-fog">{pct(s.audio[m.key])}</span>
            <button className={`cz-btn cz-btn-ghost px-3 py-1 text-xs ${focus}`} onClick={() => test(m.key)} aria-label={`Play a ${m.label.toLowerCase()} sample`}>Test</button>
          </Row>
        ))}
        <Toggle id="mute-bg" checked={s.muteInBackground} onChange={(v) => set((x) => ({ ...x, muteInBackground: v }))} label="Mute when the game is in the background" />
      </Panel>

      <Panel title="Subtitles" className="mt-4">
        <Toggle id="subs-on" checked={s.subtitles.on} onChange={(v) => set((x) => ({ ...x, subtitles: { ...x.subtitles, on: v } }))} label="Show radio and briefing subtitles" hint="The radio still plays with subtitles off." />
        <Row label="Size">
          <div role="radiogroup" aria-label="Subtitle size" className="flex gap-2">
            {(['s', 'm', 'l'] as SubtitleSize[]).map((z) => (
              <label key={z} className={`cz-btn cursor-pointer px-4 py-1.5 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-amber-hi ${s.subtitles.size === z ? 'cz-btn-primary' : 'cz-btn-ghost'}`}>
                <input type="radio" name="subsize" value={z} checked={s.subtitles.size === z} onChange={() => set((x) => ({ ...x, subtitles: { ...x.subtitles, size: z } }))} className="sr-only" data-testid={`subsize-${z}`} />
                {z === 's' ? 'Small' : z === 'm' ? 'Medium' : 'Large'}
              </label>
            ))}
          </div>
        </Row>
        <Row label="Background" htmlFor="subs-bg" hint="A dark box behind the text">
          <input id="subs-bg" type="range" min={0} max={1} step={0.05} value={s.subtitles.background} onChange={(e) => { const v = Number(e.currentTarget.value); set((x) => ({ ...x, subtitles: { ...x.subtitles, background: v } })) }} className={`flex-1 accent-amber ${focus}`} aria-valuetext={pct(s.subtitles.background)} />
          <span className="w-12 text-right text-sm tabular-nums text-fog">{pct(s.subtitles.background)}</span>
        </Row>
        <Toggle id="subs-color" checked={s.subtitles.speakerColors} onChange={(v) => set((x) => ({ ...x, subtitles: { ...x.subtitles, speakerColors: v } }))} label="Colour speaker names" hint="Off: every name in white." />
        <div className="mt-2 flex justify-center rounded border border-line bg-[#20262c] p-6" aria-hidden data-testid="subs-preview">
          <div style={{ textAlign: 'center', background: `rgba(0,0,0,${s.subtitles.background})`, padding: s.subtitles.background > 0 ? '8px 14px' : 0, borderRadius: 6, opacity: s.subtitles.on ? 1 : 0.25 }}>
            <div style={{ fontSize: Math.round((s.subtitles.size === 's' ? 13 : s.subtitles.size === 'l' ? 21 : 16) * 0.72), letterSpacing: 3, fontWeight: 700, color: s.subtitles.speakerColors ? '#8fd6e8' : '#e9edf2' }}>KESTREL</div>
            <div style={{ fontSize: s.subtitles.size === 's' ? 13 : s.subtitles.size === 'l' ? 21 : 16, lineHeight: 1.5, color: '#e9edf2', textShadow: '0 0 8px #000' }}>That’s the yard. Get on the cargo.</div>
          </div>
        </div>
      </Panel>

      <Panel title="Controls" className="mt-4">
        <Row label="Look sensitivity" htmlFor="sens" hint="Mouse, arrow keys and touch">
          <input id="sens" type="range" min={SENS_RANGE[0]} max={SENS_RANGE[1]} step={0.05} value={s.lookSens} onChange={(e) => { const v = Number(e.currentTarget.value); set((x) => ({ ...x, lookSens: v })) }} className={`flex-1 accent-amber ${focus}`} aria-valuetext={`${s.lookSens.toFixed(2)} times`} />
          <span className="w-12 text-right text-sm tabular-nums text-fog">{s.lookSens.toFixed(2)}×</span>
        </Row>
        <Toggle id="toggle-interact" checked={s.access.toggleInteract} onChange={(v) => set((x) => ({ ...x, access: { ...x.access, toggleInteract: v } }))} label="Press E once to interact (instead of holding)" hint="The action runs until it completes; press E again, or look away, to stop." />
        <p className="mt-2 text-xs text-dim">Keys: WASD move · mouse or arrows look · click or Space fire · Shift aim · R reload · E use · H dressing · I inspect · C crouch · Q / G lean · X swap · N night vision · F light · Esc pause.</p>
      </Panel>

      <Panel title="Accessibility" className="mt-4">
        <Toggle id="reduce-motion" checked={s.access.reduceMotion} onChange={(v) => set((x) => ({ ...x, access: { ...x.access, reduceMotion: v } }))} label="Reduce motion" hint="No camera shake, head bob or weapon sway; gentler hit reactions. Follows your system setting until you choose." />
        <Toggle id="reduce-flashes" checked={s.access.reduceFlashes} onChange={(v) => set((x) => ({ ...x, access: { ...x.access, reduceFlashes: v } }))} label="Reduce flashes" hint="No full-screen hit flash or blast fireball, steady flares and fire, and much dimmer muzzle light." />
      </Panel>

      <div className="mt-6 flex gap-3">
        <button className={`cz-btn cz-btn-ghost px-5 py-2 text-sm ${focus}`} onClick={() => saveSettings({ ...DEFAULTS, quality: s.quality })} data-testid="reset">Reset to defaults</button>
      </div>
    </Shell>
  )
}
