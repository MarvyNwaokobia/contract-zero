//! Deterministic agent policies.
//!
//! These are what each NPC does when the LLM planner is unavailable, times out, or
//! proposes something invalid. They read only the world (the same observation the
//! LLM gets) and return actions that the engine then validates like any other.
//!
//! - **Ironveil (commander):** keep every consumed resource above its operational
//!   requirement by buying the gap from Vex; sell surplus ammunition; raise convoy
//!   defense after recent raids and relax it when things are quiet; when its own
//!   medical stock is short, put a bounty on Vex's supply caravan.
//! - **Vex (merchant):** post bounties on Ironveil fuel convoys while its own fuel is
//!   under target, paying more against better-defended convoys; widen its margin
//!   when any shelf is running low.

use crate::pricing::{BP, Strategy};
use crate::*;

/// How far back an actor remembers raids on its convoys.
pub const RAID_MEMORY_TICKS: u64 = 48;
pub const BASE_DEFENSE: u8 = 2;

pub fn recent_raids(w: &World, owner: &str) -> usize {
    let since = w.tick.saturating_sub(RAID_MEMORY_TICKS);
    w.convoys.values().filter(|c| c.owner == owner && c.status == ConvoyStatus::Raided && c.dispatched_at >= since).count()
}

fn spendable(w: &World, a: &Actor) -> i64 {
    (w.balance(&a.account, Asset::Credits) - a.credit_reserve).max(0)
}

fn open_contract_on(w: &World, convoy: u64) -> bool {
    w.contracts.values().any(|c| c.convoy == convoy && matches!(c.status, ContractStatus::Open | ContractStatus::Accepted { .. }))
}

/// Largest buy of `r` up to `want` units that fits in `budget`, with a fresh quote as the limit.
fn affordable_buy(w: &World, r: Resource, want: i64, budget: i64) -> Option<Action> {
    let mut qty = want.min(w.merchant_stock(r));
    while qty > 0 {
        if let Ok(q) = w.quote(r, Side::Buy, qty) {
            if q.total <= budget {
                return Some(Action::Trade { resource: r, side: Side::Buy, qty, limit_total: q.total });
            }
        }
        qty = qty * 3 / 4;
    }
    None
}

pub fn commander(w: &World, id: &str) -> Vec<Action> {
    let Ok(a) = w.actor(id) else { return vec![] };
    let mut out = Vec::new();
    let mut budget = spendable(w, a);

    for r in Resource::ALL {
        let need = a.requirement(r);
        let have = w.balance(&a.account, Asset::Res(r));
        if need > 0 && have < need {
            if let Some(Action::Trade { qty, resource, side, limit_total }) = affordable_buy(w, r, need - have, budget) {
                budget -= limit_total;
                out.push(Action::Trade { resource, side, qty, limit_total });
            }
        }
    }

    // Sell ammunition the garrison will not need.
    let ammo = w.balance(&a.account, Asset::Res(Resource::Ammo));
    let keep = a.requirement(Resource::Ammo) * 2 + 40;
    if ammo > keep {
        if let Ok(q) = w.quote(Resource::Ammo, Side::Sell, ammo - keep) {
            out.push(Action::Trade { resource: Resource::Ammo, side: Side::Sell, qty: q.qty, limit_total: q.total });
        }
    }

    let raids = recent_raids(w, id) as u8;
    let mut level = (BASE_DEFENSE + raids).min(DEFENSE_MAX);
    if w.balance(&a.account, Asset::Credits) < a.credit_reserve {
        level = DEFENSE_MIN;
    }
    if level != a.defense {
        out.push(Action::ConfigureDefense { level });
    }

    // Short on medicine: pay raiders to take Vex's caravan.
    let med_short = w.balance(&a.account, Asset::Res(Resource::Med)) < a.requirement(Resource::Med);
    if med_short {
        for c in w.convoys.values().filter(|c| c.owner == w.market.merchant && c.status == ConvoyStatus::InTransit && !open_contract_on(w, c.id)) {
            let (min, max) = w.bounty_range(c);
            let bounty = (w.cargo_value(c) * 6_000 / BP).clamp(min, max);
            if bounty <= budget {
                budget -= bounty;
                out.push(Action::PostContract { convoy: c.id, bounty });
            }
        }
    }
    out
}

pub fn merchant(w: &World) -> Vec<Action> {
    let id = w.market.merchant.clone();
    let Ok(a) = w.actor(&id) else { return vec![] };
    let mut out = Vec::new();
    let mut budget = spendable(w, a);

    let fuel = w.merchant_stock(Resource::Fuel);
    if fuel < w.market.target[Resource::Fuel.idx()] {
        for c in w.convoys.values().filter(|c| c.owner != id && c.resource == Resource::Fuel && c.status == ConvoyStatus::InTransit && !open_contract_on(w, c.id)) {
            let (min, max) = w.bounty_range(c);
            // Better-guarded convoys need a bigger bounty to attract anyone.
            let share = 4_000 + 1_000 * (c.defense as i64 - 1);
            let bounty = (w.cargo_value(c) * share / BP).clamp(min, max);
            if bounty <= budget {
                budget -= bounty;
                out.push(Action::PostContract { convoy: c.id, bounty });
            }
        }
    }

    let low_shelf = Resource::ALL.iter().any(|&r| w.merchant_stock(r) * 2 < w.market.target[r.idx()]);
    let margin_bp = if low_shelf { 3_000 } else { 2_000 };
    if margin_bp != w.market.strategy.margin_bp {
        out.push(Action::SetStrategy { strategy: Strategy { margin_bp, spread_bp: w.market.strategy.spread_bp } });
    }
    out
}

/// Run both agents' fallback policies once and execute what they decide. Returns each
/// proposal with its result; rejected proposals change nothing.
pub fn run_fallback_agents(w: &mut World) -> Vec<(String, Action, Result<Vec<Event>, EconError>)> {
    let mut log = Vec::new();
    for id in w.actors.keys().cloned().collect::<Vec<_>>() {
        let actions = if id == w.market.merchant { merchant(w) } else { commander(w, &id) };
        for act in actions {
            let r = w.execute(&Caller::Agent(id.clone()), &act);
            log.push((id.clone(), act, r));
        }
    }
    log
}
