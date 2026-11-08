import type { GunStats } from './GunStats'

// ── Ammo Types ──────────────────────────────────────────────────────────────

export type AmmoId = 'standard' | 'hollow_point' | 'armor_piercing' | 'tracer' | 'incendiary'

export interface AmmoType {
  id: AmmoId
  name: string
  description: string
  damageMult: number      // multiplies base damage
  accuracyMod: number     // added to base accuracy (clamped 0..1)
  fireRateMod: number     // added to base fire rate (RPM)
  critChanceMod: number   // added to base crit chance
  burnDps: number         // damage-over-time per second after a hit (0 = none)
}

export const AMMO_CATALOG: Record<AmmoId, AmmoType> = {
  standard: {
    id: 'standard', name: 'Standard FMJ', description: 'Factory full metal jacket rounds.',
    damageMult: 1.0, accuracyMod: 0, fireRateMod: 0, critChanceMod: 0, burnDps: 0,
  },
  hollow_point: {
    id: 'hollow_point', name: 'Hollow Point', description: 'Expanding rounds — +20% damage on impact, tears through soft targets.',
    damageMult: 1.20, accuracyMod: 0, fireRateMod: 0, critChanceMod: 0, burnDps: 0,
  },
  armor_piercing: {
    id: 'armor_piercing', name: 'Armor Piercing', description: 'Tungsten-core penetrators — +10% damage and +5% crit chance, punches through armor.',
    damageMult: 1.10, accuracyMod: 0, fireRateMod: 0, critChanceMod: 0.05, burnDps: 0,
  },
  tracer: {
    id: 'tracer', name: 'Tracer Rounds', description: 'Phosphor-tipped tracers — +8% accuracy and +30 RPM from visual tracking.',
    damageMult: 1.0, accuracyMod: 0.08, fireRateMod: 30, critChanceMod: 0, burnDps: 0,
  },
  incendiary: {
    id: 'incendiary', name: 'Incendiary Rounds', description: 'Thermite-laced bullets — 3 HP/s burn damage after each hit for 2 seconds.',
    damageMult: 1.0, accuracyMod: 0, fireRateMod: 0, critChanceMod: 0, burnDps: 3,
  },
}

// ── Attachments ─────────────────────────────────────────────────────────────

export type AttachmentSlot = 'barrel' | 'optic' | 'grip' | 'magazine'

export type AttachmentId =
  | 'suppressor' | 'extended_barrel'
  | 'red_dot' | 'acog_scope'
  | 'foregrip' | 'quick_grip'
  | 'extended_mag' | 'speed_loader'

export interface Attachment {
  id: AttachmentId
  name: string
  description: string
  slot: AttachmentSlot
  accuracyMod: number
  fireRateMod: number
  rangeMod: number
  magazineMod: number     // added to magazine capacity
  reloadTimeMod: number   // added to reload time (negative = faster)
}

export const ATTACHMENT_CATALOG: Record<AttachmentId, Attachment> = {
  // Barrel
  suppressor: {
    id: 'suppressor', name: 'Suppressor', description: 'Reduces muzzle flash — +6% accuracy, -1m range.',
    slot: 'barrel', accuracyMod: 0.06, fireRateMod: 0, rangeMod: -1, magazineMod: 0, reloadTimeMod: 0,
  },
  extended_barrel: {
    id: 'extended_barrel', name: 'Extended Barrel', description: 'Longer barrel — +2m range, -20 RPM from added weight.',
    slot: 'barrel', accuracyMod: 0, fireRateMod: -20, rangeMod: 2, magazineMod: 0, reloadTimeMod: 0,
  },
  // Optic
  red_dot: {
    id: 'red_dot', name: 'Red Dot Sight', description: 'Fast target acquisition — +5% accuracy.',
    slot: 'optic', accuracyMod: 0.05, fireRateMod: 0, rangeMod: 0, magazineMod: 0, reloadTimeMod: 0,
  },
  acog_scope: {
    id: 'acog_scope', name: 'ACOG Scope', description: 'Magnified optic — +8% accuracy, +1m range.',
    slot: 'optic', accuracyMod: 0.08, fireRateMod: 0, rangeMod: 1, magazineMod: 0, reloadTimeMod: 0,
  },
  // Grip
  foregrip: {
    id: 'foregrip', name: 'Foregrip', description: 'Vertical grip — +4% accuracy from recoil control.',
    slot: 'grip', accuracyMod: 0.04, fireRateMod: 0, rangeMod: 0, magazineMod: 0, reloadTimeMod: 0,
  },
  quick_grip: {
    id: 'quick_grip', name: 'Quick Grip', description: 'Lightweight angled grip — +40 RPM from faster handling.',
    slot: 'grip', accuracyMod: 0, fireRateMod: 40, rangeMod: 0, magazineMod: 0, reloadTimeMod: 0,
  },
  // Magazine
  extended_mag: {
    id: 'extended_mag', name: 'Extended Magazine', description: 'Larger mag — +10 rounds, +0.4s reload from extra weight.',
    slot: 'magazine', accuracyMod: 0, fireRateMod: 0, rangeMod: 0, magazineMod: 10, reloadTimeMod: 0.4,
  },
  speed_loader: {
    id: 'speed_loader', name: 'Speed Loader', description: 'Quick-release mechanism — -0.5s reload time.',
    slot: 'magazine', accuracyMod: 0, fireRateMod: 0, rangeMod: 0, magazineMod: 0, reloadTimeMod: -0.5,
  },
}

// ── Loadout resolution ──────────────────────────────────────────────────────

export interface Loadout {
  gunId: string
  ammoId: AmmoId
  attachments: Partial<Record<AttachmentSlot, AttachmentId>>
}

export function resolveGunStats(
  baseGun: GunStats,
  ammoId: AmmoId = 'standard',
  attachments: Partial<Record<AttachmentSlot, AttachmentId>> = {},
): GunStats {
  const ammo = AMMO_CATALOG[ammoId]
  let accuracy = baseGun.accuracy + ammo.accuracyMod
  let fireRate = baseGun.fireRate + ammo.fireRateMod
  let range = baseGun.range
  let magazine = baseGun.magazine
  let reloadTime = baseGun.reloadTime
  let critChance = baseGun.critChance + ammo.critChanceMod
  const damage = Math.round(baseGun.damage * ammo.damageMult)

  for (const attId of Object.values(attachments)) {
    if (!attId) continue
    const att = ATTACHMENT_CATALOG[attId]
    accuracy += att.accuracyMod
    fireRate += att.fireRateMod
    range += att.rangeMod
    magazine += att.magazineMod
    reloadTime += att.reloadTimeMod
  }

  return {
    ...baseGun,
    damage,
    fireRate: Math.max(30, fireRate),
    accuracy: Math.min(0.99, Math.max(0.1, accuracy)),
    range: Math.max(3, range),
    critChance: Math.min(0.5, Math.max(0, critChance)),
    magazine: Math.max(1, magazine),
    reloadTime: Math.max(0.3, reloadTime),
  }
}
