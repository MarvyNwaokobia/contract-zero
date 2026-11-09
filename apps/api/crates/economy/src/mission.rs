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
    /// The site it happens at (`site::site_for`). Empty on plans saved before sites.
    #[serde(default)]
    pub site: String,
}

impl RaidPlan {
    pub fn site(&self) -> &'static crate::site::Site {
        crate::site::site(&self.site).unwrap_or_else(|| crate::site::site_for(&self.target, self.kind, self.resource))
    }
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
    let site = crate::site::site_for(target, crate::OpKind::Raid, resource).id.into();
    Some(RaidPlan { target: target.into(), resource, manifest, kind: crate::OpKind::Raid, contract: None, defense: a.defense, guards, seed, site })
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
    let site = crate::site::site_for(target, kind, resource).id.into();
    Some(RaidPlan { target: target.into(), resource, manifest, kind, contract: Some(contract.id), defense: a.defense, guards, seed, site })
}

// ── The physical objects of an operation ─────────────────────────────────────
//
// What the player can touch on the map, fixed when the operation starts and stored
// with the session. The client places these objects; the server only ever credits
// what is in this list, by id, so a completion can name objects but never amounts.

/// Economic units carried in one cargo case. A 60-unit shipment is three cases.
pub const UNITS_PER_CASE: i64 = 25;
pub const MAX_CASES: i64 = 4;
/// Seconds of holding E to secure one cargo case.
pub const CASE_SECS: f64 = 2.0;
/// Seconds to plant one sabotage charge.
pub const CHARGE_SECS: f64 = 5.0;
/// Seconds to free the recovery case from where it is held.
pub const RETRIEVE_SECS: f64 = 3.0;
/// Seconds inside the extraction zone once extraction is called.
pub const EXTRACT_SECS: f64 = 8.0;
/// Walking the site in and back out.
pub const TRAVERSAL_SECS: f64 = 25.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CargoCase {
    pub id: String,
    pub units: i64,
}

/// Loose supplies on site: `ammo` crates hold magazines, `med` cases hold field
/// dressings. They are used up in the fight and are never economic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldContainer {
    pub id: String,
    pub kind: String,
    pub qty: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldManifest {
    /// Raid: the cargo split into cases. Recovery: the one seized case.
    pub cases: Vec<CargoCase>,
    /// Sabotage: the charge sites, both required.
    pub charges: Vec<String>,
    pub containers: Vec<FieldContainer>,
}

impl FieldManifest {
    pub fn case_units(&self, id: &str) -> Option<i64> {
        self.cases.iter().find(|c| c.id == id).map(|c| c.units)
    }
}

/// Split `units` into `n` cases as evenly as possible (the first cases take the remainder).
pub fn split_cases(units: i64, prefix: &str) -> Vec<CargoCase> {
    let n = ((units + UNITS_PER_CASE - 1) / UNITS_PER_CASE).clamp(1, MAX_CASES);
    (0..n).map(|i| CargoCase { id: format!("{prefix}-{}", i + 1), units: units / n + i64::from(i < units % n) }).collect()
}

/// The objects for `plan` against the faction's live stock: loose ammunition is what
/// the faction has to spare, and medical cases exist only if it holds medicine.
pub fn field_manifest(w: &World, plan: &RaidPlan) -> FieldManifest {
    let cases = match plan.kind {
        crate::OpKind::Raid => split_cases(plan.manifest, "case"),
        crate::OpKind::Recovery => vec![CargoCase { id: "seized-case".into(), units: plan.manifest }],
        crate::OpKind::Sabotage => vec![],
    };
    let charges = if plan.kind == crate::OpKind::Sabotage { vec!["charge-1".into(), "charge-2".into()] } else { vec![] };
    let med = w.actors.get(&plan.target).map_or(0, |a| w.balance(&a.account, Asset::Res(Resource::Med)));
    let ammo_crates = 1 + (plan.guards.ammo_available.max(0) / 60).min(3);
    let med_cases = if med <= 0 { 0 } else if med < 20 { 1 } else { 2 };
    let mut containers: Vec<FieldContainer> = (0..ammo_crates).map(|i| FieldContainer { id: format!("ammo-{}", i + 1), kind: "ammo".into(), qty: 3 }).collect();
    containers.extend((0..med_cases).map(|i| FieldContainer { id: format!("med-{}", i + 1), kind: "med".into(), qty: 2 }));
    FieldManifest { cases, charges, containers }
}

/// The least time an operation can physically take, given how many cases were secured.
pub fn min_secs(kind: crate::OpKind, cases_secured: usize) -> f64 {
    TRAVERSAL_SECS
        + EXTRACT_SECS
        + match kind {
            crate::OpKind::Raid => CASE_SECS * cases_secured.max(1) as f64,
            crate::OpKind::Sabotage => 2.0 * CHARGE_SECS,
            crate::OpKind::Recovery => RETRIEVE_SECS,
        }
}

/// What the client says the player did. Only ids: amounts come from the manifest.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldRecord {
    #[serde(default)]
    pub secured: Vec<String>,
    #[serde(default)]
    pub charges: Vec<String>,
    #[serde(default)]
    pub delivered: Option<String>,
    #[serde(default)]
    pub looted: Vec<String>,
}

/// Checks a record against the manifest and returns the units it earns.
pub fn assess(kind: crate::OpKind, m: &FieldManifest, r: &FieldRecord) -> Result<i64, &'static str> {
    fn unique(v: &[String]) -> bool {
        let mut s: Vec<&String> = v.iter().collect();
        s.sort();
        s.windows(2).all(|p| p[0] != p[1])
    }
    if !unique(&r.secured) || !unique(&r.charges) || !unique(&r.looted) {
        return Err("an object was reported twice");
    }
    if r.looted.iter().any(|id| !m.containers.iter().any(|c| &c.id == id)) {
        return Err("looted a container that isn't on site");
    }
    match kind {
        crate::OpKind::Raid => {
            if r.secured.is_empty() {
                return Err("no cargo was secured");
            }
            r.secured.iter().map(|id| m.case_units(id).ok_or("secured a case that isn't on site")).sum()
        }
        crate::OpKind::Sabotage => {
            if r.charges.len() != m.charges.len() || r.charges.iter().any(|c| !m.charges.contains(c)) {
                return Err("not every charge was placed");
            }
            Ok(0)
        }
        crate::OpKind::Recovery => {
            let want = m.cases.first().ok_or("nothing to recover")?;
            if r.delivered.as_deref() != Some(want.id.as_str()) {
                return Err("the seized case was not delivered");
            }
            Ok(want.units)
        }
    }
}

#[cfg(test)]
mod field_tests {
    use super::*;
    use crate::OpKind;

    #[test]
    fn cargo_splits_into_a_few_cases_that_sum_to_the_manifest() {
        let c = split_cases(60, "case");
        assert_eq!(c.len(), 3);
        assert_eq!(c.iter().map(|c| c.units).sum::<i64>(), 60);
        assert_eq!(split_cases(10, "case").len(), 1);
        assert_eq!(split_cases(1_000, "case").len(), MAX_CASES as usize);
        assert_eq!(split_cases(61, "case").iter().map(|c| c.units).collect::<Vec<_>>(), vec![21, 20, 20]);
    }

    fn manifest() -> FieldManifest {
        FieldManifest {
            cases: split_cases(60, "case"),
            charges: vec!["charge-1".into(), "charge-2".into()],
            containers: vec![FieldContainer { id: "ammo-1".into(), kind: "ammo".into(), qty: 3 }],
        }
    }
    fn rec(secured: &[&str]) -> FieldRecord {
        FieldRecord { secured: secured.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn amounts_come_from_the_manifest_never_the_client() {
        let m = manifest();
        assert_eq!(assess(OpKind::Raid, &m, &rec(&["case-1", "case-3"])), Ok(40));
        assert_eq!(assess(OpKind::Raid, &m, &rec(&["case-1", "case-1"])), Err("an object was reported twice"));
        assert_eq!(assess(OpKind::Raid, &m, &rec(&["case-9"])), Err("secured a case that isn't on site"));
        assert_eq!(assess(OpKind::Raid, &m, &rec(&[])), Err("no cargo was secured"));
        let loot = FieldRecord { looted: vec!["ammo-7".into()], ..rec(&["case-1"]) };
        assert_eq!(assess(OpKind::Raid, &m, &loot), Err("looted a container that isn't on site"));
    }

    #[test]
    fn sabotage_needs_both_charges_and_recovery_the_case() {
        let m = manifest();
        let one = FieldRecord { charges: vec!["charge-1".into()], ..Default::default() };
        assert!(assess(OpKind::Sabotage, &m, &one).is_err());
        let both = FieldRecord { charges: vec!["charge-2".into(), "charge-1".into()], ..Default::default() };
        assert_eq!(assess(OpKind::Sabotage, &m, &both), Ok(0));
        let r = FieldManifest { cases: vec![CargoCase { id: "seized-case".into(), units: 30 }], ..Default::default() };
        assert!(assess(OpKind::Recovery, &r, &FieldRecord::default()).is_err());
        let d = FieldRecord { delivered: Some("seized-case".into()), ..Default::default() };
        assert_eq!(assess(OpKind::Recovery, &r, &d), Ok(30));
    }

    #[test]
    fn minimum_time_grows_with_what_was_done() {
        assert!(min_secs(OpKind::Raid, 3) > min_secs(OpKind::Raid, 1));
        assert!(min_secs(OpKind::Sabotage, 0) >= TRAVERSAL_SECS + 2.0 * CHARGE_SECS);
    }
}
