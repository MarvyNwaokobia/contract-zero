import * as THREE from 'three';

export interface DamageEvent {
  attackerId: string;
  defenderId: string;
  rawDamage: number;
  finalDamage: number;
  blocked: boolean;
  parried: boolean;
  critical: boolean;
  hitType: 'light' | 'heavy' | 'special';
  knockbackDir: THREE.Vector3;
  knockbackForce: number;
  hitStun: number;
  hitPosition: THREE.Vector3;
  killed: boolean;
}

export type DamageListener = (event: DamageEvent) => void;

export interface FighterStats {
  attack: number;
  defense: number;
  critRate: number;
  critMultiplier: number;
  blockEfficiency: number;
  staminaMax: number;
  stamina: number;
  staminaRegen: number;
}

const CLASS_BASE_STATS: Record<string, FighterStats> = {
  berserker: {
    attack: 1.3,
    defense: 0.9,
    critRate: 0.15,
    critMultiplier: 1.8,
    blockEfficiency: 0.6,
    staminaMax: 100,
    stamina: 100,
    staminaRegen: 8,
  },
  sentinel: {
    attack: 1.0,
    defense: 1.4,
    critRate: 0.08,
    critMultiplier: 1.5,
    blockEfficiency: 0.85,
    staminaMax: 120,
    stamina: 120,
    staminaRegen: 6,
  },
  phantom: {
    attack: 1.1,
    defense: 0.8,
    critRate: 0.25,
    critMultiplier: 2.0,
    blockEfficiency: 0.5,
    staminaMax: 80,
    stamina: 80,
    staminaRegen: 12,
  },
};

export function getBaseStats(classId: string): FighterStats {
  return { ...(CLASS_BASE_STATS[classId] ?? CLASS_BASE_STATS.berserker) };
}

export class DamageSystem {
  private listeners: DamageListener[] = [];
  private stats: Map<string, FighterStats> = new Map();

  registerFighter(id: string, classId: string) {
    this.stats.set(id, getBaseStats(classId));
  }

  getStats(id: string): FighterStats | undefined {
    return this.stats.get(id);
  }

  onDamage(listener: DamageListener) {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  updateStamina(dt: number) {
    for (const stats of this.stats.values()) {
      stats.stamina = Math.min(
        stats.staminaMax,
        stats.stamina + stats.staminaRegen * dt
      );
    }
  }

  consumeStamina(id: string, amount: number): boolean {
    const stats = this.stats.get(id);
    if (!stats) return false;
    if (stats.stamina < amount) return false;
    stats.stamina -= amount;
    return true;
  }

  hasStamina(id: string, amount: number): boolean {
    const stats = this.stats.get(id);
    return stats ? stats.stamina >= amount : false;
  }
}
