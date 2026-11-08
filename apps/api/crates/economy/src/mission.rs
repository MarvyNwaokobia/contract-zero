//! How economic state becomes battlefield state. One rule per resource:
//!
//! | Resource | Battlefield effect |
//! |---|---|
//! | **Ammunition** | how many guards the faction can field, and with what. A rifle guard needs `AMMO_PER_RIFLE`, a sidearm guard `AMMO_PER_SIDEARM`; a guard it cannot arm at all does not deploy. Guards draw on the stock that is NOT sitting in the raided depot. |
//! | **Medicine** | reinforcements during the cargo hold: wounded guards patched up and sent back. At or above requirement → full drops; short → one at a time; none → no reinforcements. |
//! | **Fuel** | logistics. A depot can only be staged (and so raided) if the faction holds `STAGING_FUEL`; supply shipments also burn fuel to run. |
//!
//! Every rule is a pure function of the world, so the mission the player fights is
//! exactly the one the server validates.

use serde::{Deserialize, Serialize};

use crate::pricing::BP;
use crate::{Asset, Resource, World};

pub const AMMO_PER_RIFLE: i64 = 8;
pub const AMMO_PER_SIDEARM: i64 = 2;
/// A sidearm guard hits this hard relative to a rifle guard (basis points).
pub const SIDEARM_DAMAGE_BP: i64 = 4_500;
/// Share of a faction's stock of the target resource staged at the forward depot.
pub const DEPOT_SHARE_BP: i64 = 6_000;
/// A depot holding less than this is not worth a raid.
pub const MIN_MANIFEST: i64 = 10;
/// Fuel a faction needs on hand to stage a depot.
pub const STAGING_FUEL: i64 = 20;
/// Base escort HP, raised by defense posture (armor bought with escort wages).
pub const BASE_GUARD_HP: i64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Squad {
    pub rifles: i64,
    pub sidearms: i64,
}

impl Squad {
    pub fn total(&self) -> i64 {
        self.rifles + self.sidearms
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuardPlan {
    /// Guards the faction's defense posture calls for.
    pub planned: i64,
    /// Ammunition available to arm them (stock outside the depot).
    pub ammo_available: i64,
    pub hall: Squad,
    pub yard: Squad,
    pub guard_hp: i64,
    pub sidearm_damage_bp: i64,
    /// Guards per reinforcement drop during the hold (from medicine).
    pub reinforce_per_drop: i64,
    pub reinforce_every_secs_x100: i64,
}

impl GuardPlan {
    pub fn deployed(&self) -> i64 {
        self.hall.total() + self.yard.total()
    }
}

/// What a raid on `target`'s `resource` depot would face, computed from live state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RaidPlan {
    pub target: String,
    pub resource: Resource,
    /// Raid: units taken. Sabotage: units destroyed. Recovery: units returned.
    pub manifest: i64,
    #[serde(default)]
    pub kind: crate::OpKind,
    /// The contract that pays for it (sabotage and recovery always have one).
    #[serde(default)]
    pub contract: Option<u64>,
    pub defense: u8,
    pub guards: GuardPlan,
    pub seed: u32,
}

/// Guards called for by a defense posture: a forward squad plus a yard squad.
pub fn planned_guards(defense: u8) -> i64 {
    5 + 2 * defense as i64 // 7 … 15
}

/// Arm as many guards as the ammunition allows: rifles first, then sidearms; a guard
/// that cannot be armed stays home. The yard (the cargo) gets the best of them.
pub fn arm_guards(planned: i64, ammo: i64) -> (Squad, Squad) {
    let ammo = ammo.max(0);
    let rifles = planned.min(ammo / AMMO_PER_RIFLE);
    let sidearms = (planned - rifles).min((ammo - rifles * AMMO_PER_RIFLE) / AMMO_PER_SIDEARM);
    let deployed = rifles + sidearms;
    let yard_total = (deployed * 11 + 19) / 20; // ~55%, rounded up
    let yard_rifles = rifles.min(yard_total);
    let yard = Squad { rifles: yard_rifles, sidearms: yard_total - yard_rifles };
    let hall = Squad { rifles: rifles - yard.rifles, sidearms: sidearms - yard.sidearms };
    (hall, yard)
}

pub fn reinforcements(med: i64, med_requirement: i64, defense: u8) -> i64 {
    if med <= 0 {
        0
    } else if med < med_requirement {
        1
    } else if defense >= 4 {
        3
    } else {
        2
    }
}

pub fn guard_plan(defense: u8, ammo_available: i64, med: i64, med_requirement: i64) -> GuardPlan {
    let planned = planned_guards(defense);
    let (hall, yard) = arm_guards(planned, ammo_available);
    GuardPlan {
        planned,
        ammo_available,
        hall,
        yard,
        guard_hp: BASE_GUARD_HP * (BP + 1_200 * (defense as i64 - 1)) / BP,
        sidearm_damage_bp: SIDEARM_DAMAGE_BP,
        reinforce_per_drop: reinforcements(med, med_requirement, defense),
        reinforce_every_secs_x100: 450 - 40 * defense as i64,
    }
}

/// The raid on `target`'s `resource` depot, or `None` if there is nothing to raid:
/// the faction lacks the fuel to stage a depot, or the depot would be too small.
pub fn raid_plan(w: &World, target: &str, resource: Resource) -> Option<RaidPlan> {
    let a = w.actors.get(target)?;
    if a.kind != crate::ActorKind::Faction {
        return None;
    }
    let bal = |r| w.balance(&a.account, Asset::Res(r));
    if bal(Resource::Fuel) < STAGING_FUEL {
        return None;
    }
    let stock = bal(resource);
    let manifest = stock * DEPOT_SHARE_BP / BP;
    if manifest < MIN_MANIFEST {
        return None;
    }
    let ammo = bal(Resource::Ammo);
    let ammo_available = if resource == Resource::Ammo { ammo - manifest } else { ammo };
    let guards = guard_plan(a.defense, ammo_available, bal(Resource::Med), a.requirement(Resource::Med));
    let seed = (crate::splitmix(w.seed ^ (w.tick << 8) ^ resource.idx() as u64) & 0xffff_ffff) as u32;
    Some(RaidPlan { target: target.into(), resource, manifest, kind: crate::OpKind::Raid, contract: None, defense: a.defense, guards, seed })
}

/// Every raid currently available, faction by faction, resource by resource.
/// Every operation on offer: raidable depots, plus each open sabotage or recovery contract.
pub fn available_operations(w: &World) -> Vec<RaidPlan> {
    let mut out = available_raids(w);
    for b in w.open_bounties().filter(|b| b.kind != crate::OpKind::Raid) {
        if let Some(p) = operation_plan(w, b.kind, &b.target, b.resource) {
            if !out.iter().any(|q| q.kind == p.kind && q.target == p.target && q.resource == p.resource) {
                out.push(p);
            }
        }
    }
    out
}

pub fn available_raids(w: &World) -> Vec<RaidPlan> {
    w.actors
        .keys()
        .flat_map(|id| Resource::ALL.into_iter().filter_map(move |r| raid_plan(w, id, r)))
        .collect()
}

/// Seconds the cargo takes to load under fire (mirrors the client mission builder).
pub fn load_seconds(units: i64) -> i64 {
    (8 + (units as f64 / 25.0).round() as i64).clamp(8, 20)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guards_are_armed_rifles_first_then_sidearms() {
        let (hall, yard) = arm_guards(9, 9 * AMMO_PER_RIFLE);
        assert_eq!(hall.total() + yard.total(), 9);
        assert_eq!(hall.sidearms + yard.sidearms, 0);

        // 40 ammo for 9 guards: 5 rifles, nothing left for sidearms.
        let (h, y) = arm_guards(9, 40);
        assert_eq!((h.rifles + y.rifles, h.sidearms + y.sidearms), (5, 0));

        // 44 ammo: 5 rifles + 2 sidearms.
        let (h, y) = arm_guards(9, 44);
        assert_eq!((h.rifles + y.rifles, h.sidearms + y.sidearms), (5, 2));
    }

    #[test]
    fn a_faction_never_fields_more_armed_guards_than_its_ammo_allows() {
        for planned in 0..=15 {
            for ammo in [0, 1, 7, 8, 9, 20, 40, 100, 1_000] {
                let (h, y) = arm_guards(planned, ammo);
                let used = (h.rifles + y.rifles) * AMMO_PER_RIFLE + (h.sidearms + y.sidearms) * AMMO_PER_SIDEARM;
                assert!(used <= ammo, "{planned} guards, {ammo} ammo → used {used}");
                assert!(h.total() + y.total() <= planned);
                assert!(h.rifles >= 0 && h.sidearms >= 0 && y.rifles >= 0 && y.sidearms >= 0);
            }
        }
    }

    #[test]
    fn no_ammunition_means_no_guards() {
        let (h, y) = arm_guards(15, 0);
        assert_eq!(h.total() + y.total(), 0);
    }

    #[test]
    fn the_yard_gets_the_rifles() {
        let (hall, yard) = arm_guards(10, 5 * AMMO_PER_RIFLE + 5 * AMMO_PER_SIDEARM);
        assert!(yard.rifles >= hall.rifles);
    }

    #[test]
    fn medicine_sets_reinforcements() {
        assert_eq!(reinforcements(0, 24, 2), 0);
        assert_eq!(reinforcements(10, 24, 2), 1);
        assert_eq!(reinforcements(24, 24, 2), 2);
        assert_eq!(reinforcements(24, 24, 4), 3);
    }

    #[test]
    fn load_time_is_bounded() {
        assert_eq!(load_seconds(0), 8);
        assert_eq!(load_seconds(60), 10);
        assert_eq!(load_seconds(100_000), 20);
    }
}

/// A sabotage or recovery against `target`'s `resource`, or `None` without an open
/// contract for it. Same guards as a raid (the faction defends what it holds); the
/// manifest is what is destroyed (sabotage) or returned (recovery).
pub fn operation_plan(w: &World, kind: crate::OpKind, target: &str, resource: Resource) -> Option<RaidPlan> {
    if kind == crate::OpKind::Raid {
        return raid_plan(w, target, resource);
    }
    let a = w.actors.get(target)?;
    if a.kind != crate::ActorKind::Faction {
        return None;
    }
    let contract = w.contract_for(kind, target, resource)?;
    let bal = |r| w.balance(&a.account, Asset::Res(r));
    let stock = bal(resource);
    let manifest = match kind {
        crate::OpKind::Sabotage => (stock * crate::SABOTAGE_SHARE_BP / BP).max(0),
        _ => contract.units.min(stock),
    };
    if kind == crate::OpKind::Recovery && manifest < 1 {
        return None;
    }
    let ammo = bal(Resource::Ammo);
    let guards = guard_plan(a.defense, ammo, bal(Resource::Med), a.requirement(Resource::Med));
    let seed = (crate::splitmix(w.seed ^ (w.tick << 8) ^ (resource.idx() as u64 + 16 * contract.id)) & 0xffff_ffff) as u32;
    Some(RaidPlan { target: target.into(), resource, manifest, kind, contract: Some(contract.id), defense: a.defense, guards, seed })
}
