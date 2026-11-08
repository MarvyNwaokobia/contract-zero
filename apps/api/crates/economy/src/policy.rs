//! Deterministic agent policies.
//!
//! These are what each NPC does when the LLM planner is unavailable, times out, or
//! proposes something invalid, and they are the reference the LLM is checked against.
//! Each returns [`Decision`]s: what triggered it, the numbers it looked at, the action
//! it proposes (if any) and a one-line rationale. The engine validates every proposed
//! action like any other command; a decision can also conclude "do nothing".
//!
//! **Vanguard (commander).** Keeps each consumed resource above its requirement. For
//! ammunition it also wants enough to arm half its planned guards with rifles. On a
//! shortage it requests a quote from the merchant and buys the largest amount that fits
//! its spending policy (credits above its reserve). It tightens defense after recent
//! raids and relaxes it when quiet, and drops to minimum when it can't pay escorts.
//!
//! **Vex (merchant).** Suspends business while insolvent. Otherwise it sponsors
//! bounties on Vanguard depots of resources its shelves are short of, and widens its
//! margin while any shelf is below half its target.

use serde::{Deserialize, Serialize};

use crate::mission::{planned_guards, AMMO_PER_RIFLE};
use crate::pricing::{Strategy, BP};
use crate::*;

/// How far back a faction remembers raids on it.
pub const RAID_MEMORY_TICKS: u64 = 48;
pub const BASE_DEFENSE: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub actor: String,
    /// What prompted it, e.g. "ammo below target".
    pub trigger: String,
    /// The figures the decision was based on.
    pub context: Vec<(String, i64)>,
    pub action: Option<Action>,
    pub rationale: String,
}

fn decision(actor: &str, trigger: &str, context: &[(&str, i64)], action: Option<Action>, rationale: String) -> Decision {
    Decision {
        actor: actor.into(),
        trigger: trigger.into(),
        context: context.iter().map(|(k, v)| ((*k).to_string(), *v)).collect(),
        action,
        rationale,
    }
}

pub fn spendable(w: &World, a: &Actor) -> i64 {
    (w.balance(&a.account, Asset::Credits) - a.credit_reserve).max(0)
}

/// Ammunition the commander aims to hold: its operating requirement plus enough to
/// put rifles in the hands of half the guards its posture calls for.
pub fn ammo_target(a: &Actor) -> i64 {
    a.requirement(Resource::Ammo) + AMMO_PER_RIFLE * planned_guards(a.defense) / 2
}

/// Largest buy of `r` up to `want` units whose quote fits `budget`.
fn affordable_buy(w: &World, r: Resource, want: i64, budget: i64) -> Option<Quote> {
    let mut qty = want.min(w.merchant_stock(r));
    while qty > 0 {
        if let Ok(q) = w.quote(r, Side::Buy, qty) {
            if q.total <= budget {
                return Some(q);
            }
        }
        qty = if qty > 4 { qty * 3 / 4 } else { qty - 1 };
    }
    None
}

pub fn commander(w: &World, id: &str) -> Vec<Decision> {
    let Ok(a) = w.actor(id) else { return vec![] };
    let mut out = Vec::new();
    let mut budget = spendable(w, a);

    for r in Resource::ALL {
        let target = if r == Resource::Ammo { ammo_target(a) } else { a.requirement(r) };
        let have = w.balance(&a.account, Asset::Res(r));
        if target == 0 || have >= target {
            continue;
        }
        let want = target - have;
        let stock = w.merchant_stock(r);
        let trigger = format!("{} below target", r.name());
        let ctx = |extra: &[(&'static str, i64)]| {
            let mut v = vec![("have", have), ("target", target), ("budget", budget), ("merchant_stock", stock)];
            v.extend_from_slice(extra);
            v
        };
        if stock == 0 {
            out.push(decision(id, &trigger, &ctx(&[]), None, format!("Short {want} {}, but the merchant has none to sell.", r.name())));
            continue;
        }
        match affordable_buy(w, r, want, budget) {
            Some(q) => {
                let partial = if q.qty < want { format!(" ({} of the {want} short; that is all the budget or stock allows)", q.qty) } else { String::new() };
                out.push(decision(
                    id,
                    &trigger,
                    &ctx(&[("quote_qty", q.qty), ("quote_total", q.total), ("unit_ask", q.unit_now.ask)]),
                    Some(Action::Trade { resource: r, side: Side::Buy, qty: q.qty, limit_total: q.total }),
                    format!("Buy {} {} for {} credits{partial}.", q.qty, r.name(), q.total),
                ));
                budget -= q.total;
            }
            None => {
                let one = w.quote(r, Side::Buy, 1).map(|q| q.total).unwrap_or(0);
                out.push(decision(id, &trigger, &ctx(&[("unit_ask", one)]), None, format!("Short {want} {}, but even one unit ({one} cr) is over the spending policy.", r.name())));
            }
        }
    }

    // Sell ammunition beyond twice the target.
    let ammo = w.balance(&a.account, Asset::Res(Resource::Ammo));
    let keep = ammo_target(a) * 2;
    if ammo > keep && !w.merchant_insolvent() {
        if let Ok(q) = w.quote(Resource::Ammo, Side::Sell, ammo - keep) {
            out.push(decision(id, "ammo surplus", &[("have", ammo), ("keep", keep), ("quote_total", q.total)], Some(Action::Trade { resource: Resource::Ammo, side: Side::Sell, qty: q.qty, limit_total: q.total }), format!("Sell {} surplus ammo for {} credits.", q.qty, q.total)));
        }
    }

    // Defense posture follows recent raids, but only what the faction can pay for.
    let raids = w.recent_raids_on(id, RAID_MEMORY_TICKS) as i64;
    let credits = w.balance(&a.account, Asset::Credits);
    let mut level = (BASE_DEFENSE as i64 + raids).min(DEFENSE_MAX as i64) as u8;
    let mut why = if raids > 0 { format!("{raids} raid(s) in the last {RAID_MEMORY_TICKS}h: escorts up.") } else { "Quiet period: standard escorts.".to_string() };
    if credits < a.credit_reserve + DEFENSE_COST[level as usize] {
        level = DEFENSE_MIN;
        why = "Treasury below reserve: escorts cut to minimum.".into();
    }
    if level != a.defense {
        out.push(decision(id, "defense review", &[("recent_raids", raids), ("credits", credits), ("current_level", a.defense as i64)], Some(Action::ConfigureDefense { level }), why));
    }
    out
}

pub fn merchant(w: &World) -> Vec<Decision> {
    let id = w.market.merchant.clone();
    let Ok(a) = w.actor(&id) else { return vec![] };
    let credits = w.balance(&a.account, Asset::Credits);
    if w.merchant_insolvent() {
        return vec![decision(&id, "insolvency", &[("credits", credits), ("reserve", a.credit_reserve)], None, "Below the credit reserve: not buying stock or restocking until sales recover.".into())];
    }
    let mut out = Vec::new();
    let mut budget = spendable(w, a);

    for r in Resource::ALL {
        let stock = w.merchant_stock(r);
        let target = w.market.target[r.idx()];
        if stock * 2 >= target {
            continue;
        }
        for f in w.actors.values().filter(|f| f.kind == ActorKind::Faction) {
            if w.bounty_for(&f.id, r).is_some() {
                continue;
            }
            let Some(plan) = mission::raid_plan(w, &f.id, r) else { continue };
            let value = plan.manifest * pricing::production_cost(r);
            let amount = (value * 4_000 / BP).clamp(value * BOUNTY_MIN_BP / BP, value * BOUNTY_MAX_BP / BP);
            let ctx = [("stock", stock), ("target", target), ("depot", plan.manifest), ("budget", budget), ("bounty", amount)];
            if amount > budget {
                out.push(decision(&id, &format!("{} shelf low", r.name()), &ctx, None, format!("Would sponsor a raid on {}'s {} depot, but {amount} cr is over budget.", f.name, r.name())));
                continue;
            }
            budget -= amount;
            out.push(decision(&id, &format!("{} shelf low", r.name()), &ctx, Some(Action::PostBounty { target: f.id.clone(), resource: r, amount }), format!("Pay {amount} cr to whoever raids {}'s {} depot ({} units): restocks my shelf.", f.name, r.name(), plan.manifest)));
        }
    }

    let low = Resource::ALL.iter().filter(|&&r| w.merchant_stock(r) * 2 < w.market.target[r.idx()]).count() as i64;
    let margin_bp = if low > 0 { 3_000 } else { 2_000 };
    if margin_bp != w.market.strategy.margin_bp {
        out.push(decision(&id, "pricing review", &[("low_shelves", low), ("margin_bp", margin_bp)], Some(Action::SetStrategy { strategy: Strategy { margin_bp, spread_bp: w.market.strategy.spread_bp } }), if low > 0 { "Shelves running low: margin up to 30%.".into() } else { "Shelves healthy: margin back to 20%.".into() }));
    }
    out
}

/// Every agent's decisions for the current state.
pub fn decide_all(w: &World) -> Vec<Decision> {
    let mut out = Vec::new();
    for id in w.actors.keys() {
        if *id == w.market.merchant { out.extend(merchant(w)) } else { out.extend(commander(w, id)) }
    }
    out
}

/// Decide, then execute each proposed action in order. Each decision is paired with
/// its execution result (`None` when it proposed nothing). A rejected action changes
/// nothing; later decisions see the effect of earlier accepted ones.
pub fn run_fallback_agents(w: &mut World) -> Vec<(Decision, Option<Result<Vec<Event>, EconError>>)> {
    let mut log = Vec::new();
    for id in w.actors.keys().cloned().collect::<Vec<_>>() {
        let decisions = if id == w.market.merchant { merchant(w) } else { commander(w, &id) };
        for d in decisions {
            let r = d.action.as_ref().map(|act| w.execute(&Caller::Agent(id.clone()), act));
            log.push((d, r));
        }
    }
    log
}
