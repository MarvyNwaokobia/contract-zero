// The ranged stat-duel doesn't chain melee combos, but the HUD still surfaces a
// hit streak (consecutive landed shots). ComboState is the shape the sim emits and
// the HUD reads; the full melee combo-route engine was retired with the pivot.
export interface ComboState {
  count: number;
  timer: number;
  damageMultiplier: number;
  longestCombo: number;
}
