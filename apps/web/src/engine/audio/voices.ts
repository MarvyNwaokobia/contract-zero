// A voice budget: how many sounds may play at once, and which ones give way first.
//
// WebAudio one-shots cannot be stopped cheaply once started, so instead of evicting a
// sound the budget refuses new ones early, lowest priority first, as the number of live
// voices climbs. Gunfire and damage always get through; footsteps and distant effects drop
// first. A per-sound cooldown stops one event from stacking dozens of copies in a frame.
//
// Pure (no WebAudio types, time passed in) so it is unit-tested headlessly.

export type Channel = 'combat' | 'interactions' | 'ui' | 'environment' | 'radio'

export interface VoiceRequest {
  /** What it is, for cooldowns ("impact", "footstep", "enemy-shot"). */
  key: string
  channel: Channel
  /** 0..100. 90+ is critical and is never refused for load. */
  priority: number
  /** How long the voice lives, ms (an estimate is fine). */
  durationMs: number
}

export type Refusal = 'cooldown' | 'load' | 'channel'
export interface VoiceBudgetOptions {
  /** Live voices at which a normal-priority sound is refused. */
  max: number
  /** Most live voices per channel. */
  perChannel?: Partial<Record<Channel, number>>
  /** Minimum ms between two voices with the same key. */
  cooldownMs?: Record<string, number>
}

/** The share of `max` at which each priority tier is refused. */
export function loadLimit(priority: number, max: number): number {
  if (priority >= 90) return Infinity // critical: never refused for load
  if (priority >= 60) return max
  if (priority >= 30) return Math.floor(max * 0.75)
  return Math.floor(max * 0.5)
}

export class VoiceBudget {
  private live: { channel: Channel; until: number }[] = []
  private last = new Map<string, number>()
  readonly refused: Record<Refusal, number> = { cooldown: 0, load: 0, channel: 0 }
  granted = 0

  constructor(private opts: VoiceBudgetOptions) {}

  private prune(now: number) {
    this.live = this.live.filter((v) => v.until > now)
  }

  /** Live voices right now. */
  count(now: number, channel?: Channel): number {
    this.prune(now)
    return channel ? this.live.filter((v) => v.channel === channel).length : this.live.length
  }

  /** Ask to start a voice. True means go ahead (and it is now counted). */
  request(r: VoiceRequest, now: number): { ok: true } | { ok: false; why: Refusal } {
    this.prune(now)
    const cd = this.opts.cooldownMs?.[r.key] ?? 0
    const lastAt = this.last.get(r.key)
    if (cd > 0 && lastAt !== undefined && now - lastAt < cd) { this.refused.cooldown++; return { ok: false, why: 'cooldown' } }
    const cap = this.opts.perChannel?.[r.channel]
    if (cap !== undefined && r.priority < 90 && this.live.filter((v) => v.channel === r.channel).length >= cap) { this.refused.channel++; return { ok: false, why: 'channel' } }
    if (this.live.length >= loadLimit(r.priority, this.opts.max)) { this.refused.load++; return { ok: false, why: 'load' } }
    this.live.push({ channel: r.channel, until: now + r.durationMs })
    this.last.set(r.key, now)
    this.granted++
    return { ok: true }
  }
}
