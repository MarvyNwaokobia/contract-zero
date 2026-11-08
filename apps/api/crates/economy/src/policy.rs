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
//! It buys only once stock is below 75% of target (then back up to target), and won't
//! pay over twice production cost unless critically short.
//! It sells ammunition beyond twice its target to the merchant's bid, sized to what
//! the merchant can pay; on NEAR that settles as a merchant bid the commander accepts.
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
/// The commander won't pay more than this multiple of production cost unless its
/// stock is critically low (below a quarter of target).
pub const MAX_PRICE_MULT: i64 = 2;

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
        // Hysteresis: act only once stock falls below 75% of target, then restock to
        // target in one order, rather than topping up a unit or two every tick.
        if target == 0 || have * 4 >= target * 3 {
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
        // Price discipline: above twice production cost, wait unless critically low.
        let ask = w.price(r).ask;
        let ceiling = pricing::production_cost(r) * MAX_PRICE_MULT;
        if ask > ceiling && have * 4 >= target {
            out.push(decision(id, &trigger, &ctx(&[("unit_ask", ask), ("price_ceiling", ceiling)]), None, format!("Short {want} {}, but the merchant asks {ask} cr (ceiling {ceiling}); waiting while stock lasts.", r.name())));
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

    // Sell ammunition beyond twice the target to the merchant's bid, sized to what the
    // merchant can actually pay above its reserve. On chain this settles as a merchant
    // bid that the commander accepts (cz-world v2 `post_bid` / `accept_bid`).
    let ammo = w.balance(&a.account, Asset::Res(Resource::Ammo));
    let keep = ammo_target(a) * 2;
    if ammo > keep && !w.merchant_insolvent() {
        let m = w.merchant();
        let merchant_budget = (w.balance(&m.account, Asset::Credits) - m.credit_reserve).max(0);
        let mut qty = ammo - keep;
        while qty > 0 {
            match w.quote(Resource::Ammo, Side::Sell, qty) {
                Ok(q) if q.total <= merchant_budget => {
                    out.push(decision(id, "ammo surplus", &[("have", ammo), ("keep", keep), ("quote_qty", q.qty), ("quote_total", q.total), ("merchant_budget", merchant_budget)], Some(Action::Trade { resource: Resource::Ammo, side: Side::Sell, qty: q.qty, limit_total: q.total }), format!("Sell {} surplus ammo to the merchant for {} credits.", q.qty, q.total)));
                    break;
                }
                _ => qty = if qty > 4 { qty * 3 / 4 } else { qty - 1 },
            }
        }
    }

    // Defense posture follows recent raids, but only what the faction can pay for.
    let raids = w.recent_raids_on(id, RAID_MEMORY_TICKS) as i64;
    let credits = w.balance(&a.account, Asset::Credits);
    let mut level = (BASE_DEFENSE as i64 + raids).min(DEFENSE_MAX as i64) as u8;
    let mut why = if raids > 0 { format!("{raids} raid(s) in the last {RAID_MEMORY_TICKS}h: escorts up.") } else { "Quiet period: standard escorts.".to_string() };
    // A strong treasury buys extra patrols (and pays their upkeep) before any raid:
    // one level per four days of income banked above the reserve.
    let extra = ((credits - a.credit_reserve) / (4 * a.income_per_day).max(1)).clamp(0, 2) as u8;
    if extra > 0 && level < DEFENSE_MAX {
        level = (level + extra).min(DEFENSE_MAX);
        why = format!("{why} Treasury strong ({credits} cr): extra patrols on the depots.");
    }
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
