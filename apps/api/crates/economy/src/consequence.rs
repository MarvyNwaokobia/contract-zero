//! Recorded before-and-after state of an operation's target.
//!
//! Nothing here simulates. A snapshot is the faction's own numbers read from the world at
//! one tick, so a before and an after taken around a settlement show exactly what the
//! engine did, and a snapshot that was never taken cannot be invented later. What the next
//! operation would face is the engine's own `operation_plan`, or the reason there is none.

use serde::{Deserialize, Serialize};

use crate::mission::{self, GuardPlan, STAGING_FUEL};
use crate::{Asset, OpKind, Resource, World};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stock {
    pub credits: i64,
    pub ammo: i64,
    pub med: i64,
    pub fuel: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Disruption {
    pub resource: Resource,
    pub until: u64,
}

/// Days of consumption a faction wants on hand, per resource (`Actor::requirement`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    pub ammo: i64,
    pub med: i64,
    pub fuel: i64,
}

/// One faction at one tick.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactionSnapshot {
    pub tick: u64,
    pub id: String,
    pub name: String,
    pub holdings: Stock,
    pub requirement: Requirement,
    pub defense: u8,
    pub credit_reserve: i64,
    pub disrupted: Vec<Disruption>,
}

/// What the next operation of the same kind against the same target and resource would
/// face, or why there would not be one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NextPlan {
    pub available: bool,
    /// Why it is unavailable, in the engine's own terms.
    pub reason: Option<String>,
    pub manifest: i64,
    pub defense: u8,
    pub guards: Option<GuardPlan>,
}

/// The recorded consequence of one operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Consequence {
    pub kind: OpKind,
    pub target: String,
    pub resource: Resource,
    /// The faction when the operation started.
    pub before: FactionSnapshot,
    /// What the player actually faced (the plan the session was fixed to).
    pub faced: NextPlan,
    /// The faction once the operation settled. Absent until it has.
    pub after: Option<FactionSnapshot>,
    /// What the next such operation would face now. Absent until it has settled.
    pub next: Option<NextPlan>,
    /// The world tick the operation settled at; decisions after it are the reaction.
    pub settled_tick: Option<u64>,
}

pub fn faction_snapshot(w: &World, id: &str) -> Option<FactionSnapshot> {
    let a = w.actors.get(id)?;
    let bal = |r| w.balance(&a.account, Asset::Res(r));
    Some(FactionSnapshot {
        tick: w.tick,
        id: a.id.clone(),
        name: a.name.clone(),
        holdings: Stock { credits: w.balance(&a.account, Asset::Credits), ammo: bal(Resource::Ammo), med: bal(Resource::Med), fuel: bal(Resource::Fuel) },
        requirement: Requirement { ammo: a.requirement(Resource::Ammo), med: a.requirement(Resource::Med), fuel: a.requirement(Resource::Fuel) },
        defense: a.defense,
        credit_reserve: a.credit_reserve,
        disrupted: Resource::ALL.into_iter().filter(|r| w.disrupted(id, *r)).map(|r| Disruption { resource: r, until: a.disrupted_until[r.idx()] }).collect(),
    })
}

pub fn faced(plan: &mission::RaidPlan) -> NextPlan {
    NextPlan { available: true, reason: None, manifest: plan.manifest, defense: plan.defense, guards: Some(plan.guards.clone()) }
}

/// The next operation of this kind against this target, from the engine's own plan.
pub fn next_plan(w: &World, kind: OpKind, target: &str, resource: Resource) -> NextPlan {
    match mission::operation_plan(w, kind, target, resource) {
        Some(p) => faced(&p),
        None => {
            let defense = w.actors.get(target).map(|a| a.defense).unwrap_or(0);
            let reason = match w.actors.get(target) {
                None => "unknown faction".to_string(),
                Some(a) if a.kind != crate::ActorKind::Faction => "only factions stage depots".to_string(),
                Some(a) if kind == OpKind::Raid && w.balance(&a.account, Asset::Res(Resource::Fuel)) < STAGING_FUEL => {
                    format!("{} holds less than {STAGING_FUEL} fuel, so it cannot stage a depot", a.name)
                }
                Some(_) if kind == OpKind::Raid => "the depot would be too small to be worth a raid".to_string(),
                Some(_) => "no open contract for it".to_string(),
            };
            NextPlan { available: false, reason: Some(reason), manifest: 0, defense, guards: None }
        }
    }
}

/// Open the record when an operation starts.
pub fn begin(w: &World, plan: &mission::RaidPlan) -> Option<Consequence> {
    Some(Consequence {
        kind: plan.kind,
        target: plan.target.clone(),
        resource: plan.resource,
        before: faction_snapshot(w, &plan.target)?,
        faced: faced(plan),
        after: None,
        next: None,
        settled_tick: None,
    })
}

/// Close it once the operation has settled (or failed): read the world again.
pub fn settle(mut c: Consequence, w: &World) -> Consequence {
    c.after = faction_snapshot(w, &c.target);
    c.next = Some(next_plan(w, c.kind, &c.target, c.resource));
    c.settled_tick = Some(w.tick);
    c
}
