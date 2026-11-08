import { describe, it, expect, vi } from 'vitest'
import { CombatSim, type FighterId } from '@/engine/sim/CombatSim'
import { InputSystem, Action } from '@/engine/input/InputSystem'
import { AIDifficulty } from '@/engine/combat'
import { setCover } from '@/engine/sim/Cover'

// Proves the ranged stat-duel core runs fully headless — no Three rendering, no
// AnimationMixer, no WebGL/DOM — and resolves a real gunfight to a KO. Same sim
// can tick on a Node server (authoritative PvP) or the client (prediction).

describe('CombatSim (headless ranged stat-duel core)', () => {
  it('resolves a gunfight to a KO: a shooter holding Fire downs an idle target', () => {
    const sim = new CombatSim('berserker', 'phantom')
    const inA = new InputSystem()
    const inB = new InputSystem()
    const inputs: Record<FighterId, InputSystem> = { p1: inA, p2: inB }

    setCover([]) // isolate shot resolution from the procedural cover's line-of-sight

    inA.triggerAction(Action.Fire) // p1 holds Fire; auto-fires on the gun's cadence

    let hits = 0
    let sawFire = false
    let sawKo = false
    for (let i = 0; i < 3600 && !sim.isOver; i++) {
      const events = sim.step(1 / 60, inputs)
      for (const e of events) {
        if (e.kind === 'fire') sawFire = true
        if (e.kind === 'hit' && !e.event.blocked) hits++
        if (e.kind === 'ko') sawKo = true
      }
    }

    expect(sim.isOver).toBe(true)
    expect(sawFire).toBe(true)
    expect(sawKo).toBe(true)
    expect(sim.getWinner()).toBe('p1')

    const snap = sim.snapshot()
    expect(snap.fighters.p2.health).toBe(0)
    expect(snap.fighters.p2.isDead).toBe(true)
    expect(snap.fighters.p1.health).toBeGreaterThan(0)
    expect(hits).toBeGreaterThan(5) // it landed real shots along the way
  })

  it('bullets ignore Block — holding guard must not reduce shot damage (dodge is the only defense)', () => {
    // Fix Math.random mid-range: no crits, every accuracy roll lands (sidearm .80).
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const sim = new CombatSim('berserker', 'berserker')
      const inA = new InputSystem()
      const inB = new InputSystem()
      const inputs: Record<FighterId, InputSystem> = { p1: inA, p2: inB }

      setCover([])
      inA.triggerAction(Action.Fire)
      inB.triggerAction(Action.Block) // p2 turtles behind the legacy melee guard

      let firstHit: { finalDamage: number; hpBefore: number; hpAfter: number } | null = null
      for (let i = 0; i < 600 && !firstHit; i++) {
        const hpBefore = sim.snapshot().fighters.p2.health
        const events = sim.step(1 / 60, inputs)
        const hit = events.find((e) => e.kind === 'hit')
        if (hit && hit.kind === 'hit') {
          firstHit = { finalDamage: hit.event.finalDamage, hpBefore, hpAfter: sim.snapshot().fighters.p2.health }
        }
      }

      expect(firstHit).not.toBeNull()
      expect(sim.snapshot().fighters.p2.isBlocking).toBe(true) // the guard really was up
      // Full damage went through — not the old blocked 25% chip.
      expect(firstHit!.hpBefore - firstHit!.hpAfter).toBe(firstHit!.finalDamage)
      expect(firstHit!.finalDamage).toBeGreaterThan(0)
    } finally {
      rng.mockRestore()
    }
  })

  it('emits a reload event when the mag runs dry and reports reloadProgress in the snapshot', () => {
    // Fix Math.random high: every accuracy roll misses (no stagger noise) and no crits.
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    try {
      const sim = new CombatSim('berserker', 'phantom')
      const inputs: Record<FighterId, InputSystem> = { p1: new InputSystem(), p2: new InputSystem() }
      setCover([])
      inputs.p1.triggerAction(Action.Fire) // sidearm: 12 rounds at 180rpm → dry in ~4s

      let reloadEvent: { fighter: FighterId; duration: number } | null = null
      let sawProgress = 0
      let sawReloadAnim = false
      for (let i = 0; i < 6 * 60; i++) {
        for (const e of sim.step(1 / 60, inputs)) {
          if (e.kind === 'reload') reloadEvent = e
        }
        const p1 = sim.snapshot().fighters.p1
        if (p1.reloading) {
          sawProgress = Math.max(sawProgress, p1.reloadProgress)
          if (p1.animState === 'reload') sawReloadAnim = true
        }
      }

      expect(reloadEvent).not.toBeNull()
      expect(sawReloadAnim).toBe(true) // a standing mag change plays the reload clip
      expect(reloadEvent!.fighter).toBe('p1')
      expect(reloadEvent!.duration).toBeCloseTo(1.6) // sidearm reloadTime
      expect(sawProgress).toBeGreaterThan(0.5) // progress visibly advanced mid-reload
      // 6s is enough to fire 12, reload (1.6s), and be shooting again on a full mag path.
      const p1 = sim.snapshot().fighters.p1
      expect(p1.reloading ? p1.reloadProgress : 0).toBeLessThanOrEqual(1)
      expect(p1.ammo).toBeGreaterThan(0)
    } finally {
      rng.mockRestore()
    }
  })

  it('pre-rolled misses fly visibly wide instead of evaporating on the torso', () => {
    // 0.99 > sidearm accuracy 0.80 → every shot is a pre-rolled miss.
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    try {
      const sim = new CombatSim('berserker', 'phantom') // p1 at x=-5, p2 at x=+5
      const inputs: Record<FighterId, InputSystem> = { p1: new InputSystem(), p2: new InputSystem() }
      setCover([])
      inputs.p1.triggerAction(Action.Fire)

      let fire: Extract<ReturnType<CombatSim['step']>[number], { kind: 'fire' }> | null = null
      let whiff: Extract<ReturnType<CombatSim['step']>[number], { kind: 'projectileHit' }> | null = null
      for (let i = 0; i < 240 && !whiff; i++) {
        for (const e of sim.step(1 / 60, inputs)) {
          if (e.kind === 'fire' && !fire) fire = e
          if (e.kind === 'projectileHit') whiff = e
        }
      }

      // The tracer's aim point diverges laterally from the duel line (z=0) and
      // overshoots past the target (x > 5) — the round visibly flies wide.
      expect(fire).not.toBeNull()
      expect(Math.abs(fire!.target[2])).toBeGreaterThan(0.5)
      expect(fire!.target[0]).toBeGreaterThan(5)
      // And it resolves as a plain miss out at that wide point, not a dodge.
      expect(whiff).not.toBeNull()
      expect(whiff!.hit).toBe(false)
      expect(whiff!.dodged).toBe(false)
      expect(Math.abs(whiff!.position[2])).toBeGreaterThan(0.5)
    } finally {
      rng.mockRestore()
    }
  })

  it('flags a whiff as dodged when i-frames earn it (not as a wide shot)', () => {
    // 0.5 < accuracy 0.80 → the shot WOULD hit; only the dodge can save p2.
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const sim = new CombatSim('berserker', 'phantom')
      const inA = new InputSystem()
      const inB = new InputSystem()
      const inputs: Record<FighterId, InputSystem> = { p1: inA, p2: inB }
      setCover([])
      inA.triggerAction(Action.Fire)

      let fired = false
      let sinceFire = 0
      let result: Extract<ReturnType<CombatSim['step']>[number], { kind: 'projectileHit' }> | null = null
      for (let i = 0; i < 120 && !result; i++) {
        const events = sim.step(1 / 60, inputs)
        for (const e of events) {
          if (e.kind === 'fire') { fired = true; inA.releaseAction(Action.Fire) } // one shot only
          if (e.kind === 'projectileHit') result = e
        }
        if (fired && ++sinceFire === 6) inB.triggerAction(Action.Dodge) // roll ~0.1s into the flight
      }

      expect(result).not.toBeNull()
      expect(result!.hit).toBe(false)
      expect(result!.dodged).toBe(true)
      expect(sim.snapshot().fighters.p2.health).toBe(100) // i-frames ate the round
    } finally {
      rng.mockRestore()
    }
  })

  it('produces serializable snapshots (StateUpdate-ready, no class instances leaking)', () => {
    const sim = new CombatSim('sentinel', 'berserker')
    const inputs: Record<FighterId, InputSystem> = { p1: new InputSystem(), p2: new InputSystem() }
    sim.step(1 / 60, inputs)

    const snap = sim.snapshot()
    const back = JSON.parse(JSON.stringify(snap)) // round-trips → safe to send over the wire
    expect(back.fighters.p1.position).toHaveLength(3)
    expect(back.fighters.p1.health).toBe(100)
    expect(typeof back.fighters.p1.animState).toBe('string')
    expect(back.fighters.p1.gunId).toBe('sidearm')
    expect(back.fighters.p1.ammo).toBeGreaterThan(0)
    expect(back.winner).toBeNull()
  })

  it('does not award a winner while both fighters hold fire (no input)', () => {
    const sim = new CombatSim('berserker', 'phantom')
    const inputs: Record<FighterId, InputSystem> = { p1: new InputSystem(), p2: new InputSystem() }
    for (let i = 0; i < 600; i++) sim.step(1 / 60, inputs)
    expect(sim.isOver).toBe(false)
    expect(sim.getWinner()).toBeNull()
  })

  it('honours per-fighter loadout: gun choice + HP multiplier from SimOptions', () => {
    const sim = new CombatSim('berserker', 'phantom', {
      p1Gun: 'marksman',
      p2Gun: 'smg',
      p2HpMult: 2,
    })
    const snap = sim.snapshot()
    expect(snap.fighters.p1.gunId).toBe('marksman')
    expect(snap.fighters.p2.gunId).toBe('smg')
    expect(snap.fighters.p2.maxHealth).toBe(200)
    expect(snap.fighters.p2.health).toBe(200)
    expect(snap.fighters.p1.maxHealth).toBe(100)
  })

  it('a dodging target eats far less than a standing one (i-frames matter)', () => {
    const run = (dodge: boolean): number => {
      const sim = new CombatSim('berserker', 'phantom')
      const inA = new InputSystem()
      const inB = new InputSystem()
      const inputs: Record<FighterId, InputSystem> = { p1: inA, p2: inB }
      setCover([]) // isolate dodge i-frames from cover line-of-sight
      inA.triggerAction(Action.Fire)
      for (let i = 0; i < 180 && !sim.isOver; i++) {
        if (dodge) inB.triggerAction(Action.Dodge) // re-buffer to maximise i-frames
        sim.step(1 / 60, inputs)
      }
      return sim.snapshot().fighters.p2.health
    }
    expect(run(true)).toBeGreaterThan(run(false))
  })

  it('PvE: RangedAI opponents fire, dodge and trade real damage through the sim', () => {
    const sim = new CombatSim('berserker', 'phantom')
    sim.attachAI('p1', AIDifficulty.Medium)
    sim.attachAI('p2', AIDifficulty.Medium)

    let fires = 0
    let hits = 0
    for (let i = 0; i < 5400 && !sim.isOver; i++) {
      const events = sim.step(1 / 60) // both fighters AI-driven; no provided input
      for (const e of events) {
        if (e.kind === 'fire') fires++
        if (e.kind === 'hit') hits++
      }
    }

    expect(fires).toBeGreaterThan(0) // the bots actually shoot
    expect(hits).toBeGreaterThan(0)  // and land shots
    const snap = sim.snapshot()
    expect(Math.min(snap.fighters.p1.health, snap.fighters.p2.health)).toBeLessThan(100)
  })
})
