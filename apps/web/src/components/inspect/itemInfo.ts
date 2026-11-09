// What the inspector says about an item. Every value comes from the game's own
// sources: the weapon catalog (combat/GunStats), fire modes and reserve rules
// (fps/FpsSim), field rules (fps/field), and prices the server sent. Nothing is
// invented: a value the game doesn't model (condition, weight) is not shown.

import { GUN_CATALOG, gunDps, type GunId } from '@/engine/combat/GunStats'
import { GUN_FIRE_MODES, RESERVE_CAP_MAGS, MAX_MEDKITS, HEAL_HP, HEAL_SECS, ammoClassOf, type AmmoClass } from '@/engine/fps/FpsSim'
import { CARRY_MAX, CASE_SLOW, SEIZED_SLOW } from '@/engine/fps/field'

export type InspectItem =
  | { type: 'weapon'; gun: GunId; status: 'owned' | 'standard' | 'battlefield' | 'locked'; owned?: number; price?: number | null; mag?: number; reserve?: number }
  | { type: 'ammo'; cls: AmmoClass; rounds: number }
  | { type: 'med'; count: number }
  | { type: 'cargo'; resource: string; units: number; seized?: boolean; unitBid?: number | null }

export interface InspectInfo {
  title: string
  kind: string
  status: { label: string; tone: 'owned' | 'temporary' | 'neutral' | 'locked' }
  stats: { label: string; value: string }[]
  notes: string[]
  model: { gun?: GunId; prop?: 'ammo' | 'med' | 'cargo' | 'seized'; label?: string; cls?: AmmoClass }
}

const ROUNDS: Record<AmmoClass, string> = { pistol: 'Pistol rounds (9 mm)', rifle: 'Rifle rounds' }
const pct = (v: number) => `${Math.round(v * 100)}%`
const compatible = (cls: AmmoClass) => (Object.keys(GUN_CATALOG) as GunId[]).filter((g) => ammoClassOf(g) === cls).map((g) => GUN_CATALOG[g].name)

export function inspectInfo(item: InspectItem): InspectInfo {
  switch (item.type) {
    case 'weapon': {
      const g = GUN_CATALOG[item.gun]
      const cls = ammoClassOf(item.gun)
      const slot = item.gun === 'sidearm' ? 'Secondary slot' : 'Primary slot'
      const status = {
        owned: { label: `Owned · token gun:${item.gun}${item.owned && item.owned > 1 ? ` ×${item.owned}` : ''}`, tone: 'owned' as const },
        standard: { label: 'Standard issue · not a token', tone: 'neutral' as const },
        battlefield: { label: 'Battlefield pickup · temporary', tone: 'temporary' as const },
        locked: { label: 'Not owned', tone: 'locked' as const },
      }[item.status]
      const stats = [
        { label: 'Damage', value: `${g.damage} per hit` },
        { label: 'Rate of fire', value: `${g.fireRate} rpm` },
        { label: 'Fire modes', value: (GUN_FIRE_MODES[item.gun] ?? ['auto']).join(' · ') },
        { label: 'Magazine', value: `${g.magazine} rounds` },
        { label: 'Reload', value: `${g.reloadTime.toFixed(1)} s` },
        { label: 'Effective range', value: `${g.range} m` },
        { label: 'Accuracy', value: pct(g.accuracy) },
        { label: 'Critical', value: `${pct(g.critChance)} · ×${g.critMult}` },
        { label: 'Sustained DPS', value: `${Math.round(gunDps(g))}` },
        { label: 'Ammunition', value: ROUNDS[cls] },
        { label: 'Carries', value: `${slot} · up to ${RESERVE_CAP_MAGS} spare magazines` },
      ]
      if (item.mag !== undefined) stats.push({ label: 'Loaded', value: `${item.mag} in the magazine · ${item.reserve ?? 0} spare` })
      const notes: string[] = []
      if (item.status === 'battlefield') notes.push('Taken in this fight. It exists only for this run: it is never minted or transferred, and is gone when the mission ends.')
      if (item.status === 'owned') notes.push('A NEP-245 token in your NEAR account. You can carry it into any contract; the server checks you still own it.')
      if (item.status === 'standard') notes.push('Issued to every contractor. It is not a token and cannot be sold.')
      if (item.status === 'locked') notes.push('Buy one from Vex’s armory to carry it into contracts.')
      if (typeof item.price === 'number') stats.push({ label: 'Market value', value: `${item.price.toLocaleString()} cr at Vex’s armory` })
      else if (item.status === 'battlefield') stats.push({ label: 'Market value', value: 'None: it can’t be extracted' })
      else if (item.status === 'standard') stats.push({ label: 'Market value', value: 'Not sold' })
      return { title: g.name, kind: `Weapon · tier ${g.tier}`, status, stats, notes, model: { gun: item.gun } }
    }
    case 'ammo':
      return {
        title: ROUNDS[item.cls], kind: 'Field supply', status: { label: 'Field supply · not economic', tone: 'neutral' },
        stats: [
          { label: 'Rounds', value: `${item.rounds}` },
          { label: 'Fits', value: compatible(item.cls).join(', ') },
          { label: 'Capacity', value: `Up to ${RESERVE_CAP_MAGS} spare magazines per weapon; the rest stays in the crate` },
          { label: 'Market value', value: 'Not traded: used up in the fight' },
        ],
        notes: ['Loose rounds on site are not the Ammunition resource. The economy’s ammunition moves only as cargo cases.'],
        model: { prop: 'ammo', cls: item.cls },
      }
    case 'med':
      return {
        title: 'Field dressings', kind: 'Field supply', status: { label: 'Field supply · not economic', tone: 'neutral' },
        stats: [
          { label: 'In the case', value: `${item.count}` },
          { label: 'Effect', value: `+${HEAL_HP} health after ${HEAL_SECS} s, weapon lowered (H)` },
          { label: 'Capacity', value: `You carry up to ${MAX_MEDKITS}` },
          { label: 'Market value', value: 'Not traded: used up in the fight' },
        ],
        notes: ['Medical cases are only on site if the faction holds medicine.'],
        model: { prop: 'med' },
      }
    case 'cargo': {
      const slow = item.seized ? SEIZED_SLOW : CASE_SLOW
      const stats = [
        { label: 'Contents', value: `${item.units} units of ${item.resource}` },
        { label: 'Carrying it', value: `−${Math.round(slow * 100)}% movement · up to ${CARRY_MAX} cases at once` },
        { label: 'Counts when', value: item.seized ? 'Handed over at the owner’s vehicle' : 'Carried through a completed extraction' },
      ]
      if (typeof item.unitBid === 'number') stats.push({ label: 'Market value', value: `about ${(item.unitBid * item.units).toLocaleString()} cr at Vex (${item.unitBid} cr/unit)` })
      return {
        title: item.seized ? `Seized case · ${item.resource}` : `Cargo case · ${item.resource}`, kind: 'Mission cargo',
        status: { label: item.seized ? 'Belongs to the contract’s owner' : 'Yours once extracted', tone: item.seized ? 'neutral' : 'owned' },
        stats,
        notes: ['Going down drops it where you fall. The server settles only what it saw you carry out.'],
        model: { prop: item.seized ? 'seized' : 'cargo', label: item.resource.toUpperCase() },
      }
    }
  }
}
