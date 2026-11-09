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

pub fn commander(w: &World, id: &str) -> Vec<Decision> {
    let Ok(a) = w.actor(id) else { return vec![] };
    let mut out = Vec::new();
    let mut budget = spendable(w, a);

    // Supply: a shortage becomes a bounded supply order that every merchant may answer,
    // never a purchase from one predetermined merchant. A surplus becomes a sell order.
    let mut nonce = w.order_nonces.get(id).copied().unwrap_or(0);
    for r in Resource::ALL {
        let target = if r == Resource::Ammo { ammo_target(a) } else { a.requirement(r) };
        let have = w.balance(&a.account, Asset::Res(r));
        // Hysteresis: act only once stock falls below 75% of target, then restock to
        // target in one order, rather than topping up a unit or two every tick.
        if target == 0 || have * 4 >= target * 3 {
            continue;
        }
        if w.open_orders().any(|o| o.requester == id && o.resource == r && o.side == Side::Buy) {
            continue; // already asked; the choice happens when proposals arrive
        }
        // Nobody answered the last request: give the market time to move before asking
        // again (every order costs the merchants and the chain something), unless critical.
        if have * 4 >= target && unanswered_recently(w, id, r, Side::Buy, BUY_RETRY_TICKS) {
            continue;
        }
        let want = target - have;
        let trigger = format!("{} below target", r.name());
        let inbound = w.inbound(id, r);
        let critical = have * 4 < target;
        let urgency: u8 = if critical { 3 } else if have * 2 < target { 2 } else { 1 };
        // What the market is asking: the cheapest merchant's next unit.
        let best_ask = w.merchant_ids().iter().filter_map(|m| w.merchant_quote(m, r, Side::Buy, 1)).min();
        let cost = pricing::production_cost(r);
        let ceiling = cost * a.doctrine.max_price_mult;
        // Willing to pay up to the doctrine ceiling, or up to the market's hard ceiling
        // when critically short.
        let walk_away = if critical { cost * pricing::PRICE_CEIL_MULT } else { ceiling };
        let ctx = |extra: &[(&'static str, i64)]| {
            let mut v = vec![("have", have), ("target", target), ("inbound", inbound), ("budget", budget), ("urgency", urgency as i64)];
            v.extend_from_slice(extra);
            v
        };
        let Some(ask) = best_ask else {
            out.push(decision(id, &trigger, &ctx(&[]), None, format!("Short {want} {}, but no merchant has any to sell.", r.name())));
            continue;
        };
        if ask > ceiling && !critical {
            out.push(decision(id, &trigger, &ctx(&[("best_ask", ask), ("price_ceiling", ceiling)]), None, format!("Short {want} {}, but the best ask is {ask} cr (ceiling {ceiling}); holding off while stock lasts.", r.name())));
            continue;
        }
        if inbound >= want && !critical {
            out.push(decision(id, &trigger, &ctx(&[]), None, format!("Short {want} {}, but {inbound} are already on the road; not buying.", r.name())));
            continue;
        }
        let qty = want.min(budget / walk_away.max(1));
        if qty <= 0 {
            out.push(decision(id, &trigger, &ctx(&[("walk_away_unit", walk_away)]), None, format!("Short {want} {}, but the treasury can't cover even one unit at {walk_away} cr.", r.name())));
            continue;
        }
        let limit_total = qty * walk_away;
        nonce += 1;
        let partial = if qty < want { format!(" ({qty} of the {want} short; that is what the budget covers)") } else { String::new() };
        let purpose = format!("{} at {have}/{target}{}", r.name(), if critical { ": critical" } else { "" });
        out.push(decision(
            id,
            &trigger,
            &ctx(&[("order_qty", qty), ("limit_total", limit_total), ("walk_away_unit", walk_away), ("best_ask", ask)]),
            Some(Action::PlaceOrder { side: Side::Buy, resource: r, qty, limit_total, allow_partial: true, ttl_ticks: ORDER_TTL_TICKS, nonce, urgency, purpose, chain_id: None }),
            format!("Request {qty} {} for at most {limit_total} cr ({walk_away}/unit){partial}; open to every merchant.", r.name()),
        ));
        budget -= limit_total;
    }

    // Sell anything held beyond twice its target (Vanguard's ammunition, Ashen's fuel)
    // through a sell order: merchants bid, the best bid wins.
    for r in Resource::ALL {
        let have = w.balance(&a.account, Asset::Res(r));
        let keep = 2 * if r == Resource::Ammo { ammo_target(a) } else { a.requirement(r) };
        // Only in lots worth a trade: every sale settles on chain.
        if keep == 0 || have - keep < MIN_SURPLUS_LOT || w.open_orders().any(|o| o.requester == id && o.resource == r && o.side == Side::Sell) {
            continue;
        }
        // No bid met the floor last time: wait a day before offering again.
        if unanswered_recently(w, id, r, Side::Sell, SELL_RETRY_TICKS) {
            continue;
        }
        let qty = have - keep;
        // Won't sell below production cost.
        let floor = qty * pricing::production_cost(r);
        nonce += 1;
        out.push(decision(id, &format!("{} surplus", r.name()), &[("have", have), ("keep", keep), ("order_qty", qty), ("min_total", floor)], Some(Action::PlaceOrder { side: Side::Sell, resource: r, qty, limit_total: floor, allow_partial: true, ttl_ticks: ORDER_TTL_TICKS, nonce, urgency: 0, purpose: format!("{} surplus beyond {keep}", r.name()), chain_id: None }), format!("Offer {qty} surplus {} for at least {floor} cr; best bid wins.", r.name())));
    }

    out.extend(rivalry(w, a));

    // Starving and broke: take a merchant caravan carrying what is short, if one is on
    // the road. At most once per raid-memory window; the merchant will want it back.
    let seized_recently = w.convoys.values().any(|c| matches!(&c.status, ConvoyStatus::Seized { by } if by == id) && c.dispatched_at + RAID_MEMORY_TICKS > w.tick);
    if !seized_recently {
        for r in Resource::ALL {
            let target = if r == Resource::Ammo { ammo_target(a) } else { a.requirement(r) };
            let have = w.balance(&a.account, Asset::Res(r));
            let unit = w.quote(r, Side::Buy, 1).map(|q| q.total).unwrap_or(i64::MAX);
            // Below the restock line and unable to pay for the restock.
            let restock = w.quote(r, Side::Buy, (target - have).max(1)).map(|q| q.total).unwrap_or(i64::MAX);
            if target == 0 || have * 4 >= target * 3 || spendable(w, a) >= restock {
                continue;
            }
            let merchant = w.market.merchant.clone();
            if let Some(c) = w.convoys.values().find(|c| c.owner == merchant && c.resource == r && c.status == ConvoyStatus::InTransit) {
                out.push(decision(id, &format!("{} critical", r.name()), &[("have", have), ("target", target), ("spendable", spendable(w, a)), ("unit_ask", unit), ("caravan_units", c.units)], Some(Action::SeizeConvoy { convoy: c.id }), format!("Down to {have} {} and can't pay for a restock ({unit} cr a unit): seizing {}'s caravan ({} {}) on the road.", r.name(), w.merchant().name, c.units, r.name())));
                break;
            }
        }
    }

    // Defense posture follows recent raids, but only what the faction can pay for.
    let raids = w.recent_raids_on(id, RAID_MEMORY_TICKS) as i64;
    let credits = w.balance(&a.account, Asset::Credits);
    let mut level = (a.doctrine.base_defense as i64 + raids).min(DEFENSE_MAX as i64) as u8;
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

/// How long a commander's supply order stays open, in ticks.
pub const ORDER_TTL_TICKS: u64 = 6;
/// After an order lapses with nothing filled, wait this long before the same request.
pub const BUY_RETRY_TICKS: u64 = 6;
pub const SELL_RETRY_TICKS: u64 = 24;

/// Did an order like this lapse unfilled within the last `ticks`?
fn unanswered_recently(w: &World, id: &str, r: Resource, side: Side, ticks: u64) -> bool {
    w.orders.values().any(|o| o.requester == id && o.resource == r && o.side == side && o.status == OrderStatus::Expired && o.filled == 0 && o.expires_at + ticks > w.tick)
}
/// How long a faction holds a grudge against a rival that paid for raids on it.
/// The smallest surplus a faction bothers to sell.
pub const MIN_SURPLUS_LOT: i64 = 10;
pub const GRUDGE_TICKS: u64 = 72;

/// Faction against faction: retaliate against a rival that paid for raids on you; an
/// aggressive faction also pays to have a stronger rival raided first. Both act through
/// bounties, so the player decides whether the raid happens.
fn rivalry(w: &World, a: &Actor) -> Vec<Decision> {
    let mut out = Vec::new();
    let mut budget = spendable(w, a);
    for rival in w.actors.values().filter(|r| r.kind == ActorKind::Faction && r.id != a.id) {
        if w.open_bounties().any(|b| b.sponsor == a.id && b.target == rival.id) {
            continue;
        }
        let paid_against_me = w.memory.get(&a.id).and_then(|m| m.sponsors.get(&rival.id)).map_or(0, |t| t.iter().filter(|&&t| t + GRUDGE_TICKS > w.tick).count()) as i64;
        let stronger = w.balance(&rival.account, Asset::Credits) > w.balance(&a.account, Asset::Credits) * 6 / 5;
        let (trigger, why) = if paid_against_me > 0 {
            ("retaliation", format!("{} paid for {paid_against_me} raid(s) on us. Returning the favour", rival.name))
        } else if a.doctrine.aggression >= 50 && stronger {
            ("pre-emptive strike", format!("{} is richer than we are. Weakening it before it comes for us", rival.name))
        } else {
            continue;
        };
        // Hit the depot that hurts them most: their biggest.
        let Some(plan) = Resource::ALL.iter().filter_map(|&r| mission::raid_plan(w, &rival.id, r)).max_by_key(|p| p.manifest * pricing::production_cost(p.resource)) else { continue };
        let value = plan.manifest * pricing::production_cost(plan.resource);
        let amount = value * 3_500 / BP;
        let ctx = [("rival_credits", w.balance(&rival.account, Asset::Credits)), ("my_credits", w.balance(&a.account, Asset::Credits)), ("paid_raids_on_me", paid_against_me), ("depot", plan.manifest), ("bounty", amount), ("budget", budget)];
        if amount > budget || amount < 1 {
            out.push(decision(&a.id, trigger, &ctx, None, format!("{why}, but a {amount} cr bounty is over budget.")));
            continue;
        }
        budget -= amount;
        out.push(decision(&a.id, trigger, &ctx, Some(Action::PostBounty { target: rival.id.clone(), resource: plan.resource, amount }), format!("{why}: {amount} cr to whoever raids its {} depot.", plan.resource.name())));
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

    // First, my own stolen cargo: pay whoever brings it back.
    for c in w.convoys.values().filter(|c| c.owner == id) {
        let ConvoyStatus::Seized { by } = &c.status else { continue };
        if w.bounties.values().any(|b| b.convoy == Some(c.id)) {
            continue;
        }
        let value = c.units * pricing::production_cost(c.resource);
        let amount = value * 3_000 / BP;
        let ctx = [("convoy", c.id as i64), ("units", c.units), ("budget", budget), ("fee", amount)];
        if amount <= budget && amount > 0 {
            budget -= amount;
            out.push(decision(&id, "caravan seized", &ctx, Some(Action::PostContract { kind: OpKind::Recovery, target: by.clone(), resource: c.resource, amount, convoy: Some(c.id) }), format!("{by} took my caravan ({} {}). Paying {amount} cr to whoever brings it back.", c.units, c.resource.name())));
        } else {
            out.push(decision(&id, "caravan seized", &ctx, None, format!("{by} took my caravan, but a {amount} cr recovery fee is over budget.")));
        }
    }

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

    // Overstocked on something a faction makes for itself: pay to take its line down,
    // so it has to buy from me.
    for r in Resource::ALL {
        let stock = w.merchant_stock(r);
        if stock * 2 <= w.market.target[r.idx()] * 3 {
            continue;
        }
        for f in w.actors.values().filter(|f| f.kind == ActorKind::Faction && f.production[r.idx()] > 0) {
            if w.disrupted(&f.id, r) || w.contract_for(OpKind::Sabotage, &f.id, r).is_some() {
                continue;
            }
            let fstock = w.balance(&f.account, Asset::Res(r));
            let value = (f.production[r.idx()] + fstock * SABOTAGE_SHARE_BP / BP) * pricing::production_cost(r);
            let amount = value * 3_000 / BP;
            let ctx = [("my_stock", stock), ("target", w.market.target[r.idx()]), ("their_output_per_day", f.production[r.idx()]), ("budget", budget), ("fee", amount)];
            if amount > 0 && amount <= budget {
                budget -= amount;
                out.push(decision(&id, &format!("{} glut", r.name()), &ctx, Some(Action::PostContract { kind: OpKind::Sabotage, target: f.id.clone(), resource: r, amount, convoy: None }), format!("My {} shelf is overstocked while {} makes its own. Paying {amount} cr to knock its line out.", r.name(), f.name)));
            }
        }
    }

    let low = Resource::ALL.iter().filter(|&&r| w.merchant_stock(r) * 2 < w.market.target[r.idx()]).count() as i64;
    let margin_bp = if low > 0 { 3_000 } else { 2_000 };
    if margin_bp != w.market.strategy.margin_bp {
        out.push(decision(&id, "pricing review", &[("low_shelves", low), ("margin_bp", margin_bp)], Some(Action::SetStrategy { strategy: Strategy { margin_bp, spread_bp: w.market.strategy.spread_bp } }), if low > 0 { "Shelves running low: margin up to 30%.".into() } else { "Shelves healthy: margin back to 20%.".into() }));
    }
    out
}

/// A merchant answering open supply orders: price each from its own shelf, strategy
/// and limits; propose, or decline with the reason.
pub fn merchant_proposals(w: &World, id: &str) -> Vec<Decision> {
    let (Ok(m), Some(prof)) = (w.actor(id), w.profile(id)) else { return vec![] };
    let mut out = Vec::new();
    let credits = w.balance(&m.account, Asset::Credits);
    for o in w.open_orders() {
        if o.requester == id || o.expires_at <= w.tick || w.pending_proposals(o.id).any(|p| p.merchant == id) || w.proposals.values().any(|p| p.order == o.id && p.merchant == id && p.status == ProposalStatus::Accepted) {
            continue;
        }
        let r = o.resource;
        let stock = w.balance(&m.account, Asset::Res(r));
        let trigger = format!("supply order #{}", o.id);
        let base = [("order", o.id as i64), ("wants", o.remaining()), ("limit_total", o.limit_total), ("my_stock", stock), ("credits", credits)];
        let decline = |why: String| decision(id, &trigger, &base, None, why);
        match o.side {
            Side::Buy => {
                // I sell: commit at most my per-order share of the shelf.
                let commit = stock * prof.max_commit_bp / BP;
                let mut qty = o.remaining().min(commit);
                if qty <= 0 {
                    out.push(decline(format!("No {} to spare for #{} ({stock} on the shelf).", r.name(), o.id)));
                    continue;
                }
                if !o.allow_partial && qty < o.remaining() {
                    out.push(decline(format!("#{} wants all {} at once; I'll commit only {qty}.", o.id, o.remaining())));
                    continue;
                }
                // My price, never under my floor; shrink the lot if the order's limit
                // can't bear my price for all of it.
                let priced = |q: i64| w.merchant_quote(id, r, Side::Buy, q).map(|t| t.max(orders::production_floor(r, q, prof.min_margin_bp)));
                let mut total = priced(qty);
                while let Some(t) = total {
                    if orders::within_limit(o, qty, t) || !o.allow_partial || qty <= 1 {
                        break;
                    }
                    qty = if qty > 4 { qty * 3 / 4 } else { qty - 1 };
                    total = priced(qty);
                }
                match total {
                    Some(t) if orders::within_limit(o, qty, t) => out.push(decision(id, &trigger, &[("order", o.id as i64), ("qty", qty), ("total", t), ("my_stock", stock), ("margin_bp", prof.strategy.margin_bp)], Some(Action::Propose { order: o.id, qty, total: t, note: format!("{qty} of {stock} on my shelf at {} cr/unit", t / qty) }), format!("Offer {qty} {} for {t} cr on #{} ({} cr/unit, {}% margin).", r.name(), o.id, t / qty, prof.strategy.margin_bp / 100))),
                    Some(t) => out.push(decline(format!("#{} pays at most {} cr/unit; my floor is {} cr/unit. Declining.", o.id, o.limit_total / o.qty.max(1), t / qty.max(1)))),
                    None => out.push(decline(format!("Can't price {qty} {}.", r.name()))),
                }
            }
            Side::Sell => {
                // I buy: only with credits above my reserve, and only shelf room up to
                // twice my target.
                let room = (prof.target[r.idx()] * 2 - stock).max(0);
                let budget = (credits - m.credit_reserve).max(0);
                let mut qty = o.remaining().min(room);
                if qty <= 0 {
                    out.push(decline(format!("My {} shelf is full; not bidding on #{}.", r.name(), o.id)));
                    continue;
                }
                let mut total = w.merchant_quote(id, r, Side::Sell, qty);
                while let Some(t) = total {
                    if (t <= budget && orders::within_limit(o, qty, t)) || !o.allow_partial || qty <= 1 {
                        break;
                    }
                    qty = if qty > 4 { qty * 3 / 4 } else { qty - 1 };
                    total = w.merchant_quote(id, r, Side::Sell, qty);
                }
                match total {
                    Some(t) if t <= budget && orders::within_limit(o, qty, t) && (o.allow_partial || qty == o.remaining()) => out.push(decision(id, &trigger, &[("order", o.id as i64), ("qty", qty), ("total", t), ("budget", budget)], Some(Action::Propose { order: o.id, qty, total: t, note: format!("bid for {qty} at {} cr/unit", t / qty) }), format!("Bid {t} cr for {qty} {} on #{}.", r.name(), o.id))),
                    Some(t) if t > budget => out.push(decline(format!("A fair bid ({t} cr) is over what I can spend ({budget}).", ))),
                    _ => out.push(decline(format!("#{} wants at least {} cr/unit; above my bid.", o.id, o.limit_total / o.qty.max(1)))),
                }
            }
        }
    }
    out
}

/// Compare unit prices exactly: is a (total_a for qty_a) cheaper than b?
fn cheaper(ta: i64, qa: i64, tb: i64, qb: i64) -> std::cmp::Ordering {
    (ta as i128 * qb as i128).cmp(&(tb as i128 * qa as i128))
}

/// A commander choosing among the proposals on its open orders: urgent needs favour
/// coverage, routine ones price; a need that has passed is cancelled to free credits.
pub fn commander_choices(w: &World, id: &str) -> Vec<Decision> {
    let Ok(a) = w.actor(id) else { return vec![] };
    let mut out = Vec::new();
    for o in w.open_orders().filter(|o| o.requester == id) {
        let r = o.resource;
        let have = w.balance(&a.account, Asset::Res(r));
        let target = if r == Resource::Ammo { ammo_target(a) } else { a.requirement(r) };
        if o.side == Side::Buy && have * 4 >= target * 3 && o.filled == 0 {
            out.push(decision(id, &format!("order #{}", o.id), &[("have", have), ("target", target)], Some(Action::CancelOrder { order: o.id }), format!("No longer short of {} ({have}/{target}): withdrawing #{} and keeping the credits.", r.name(), o.id)));
            continue;
        }
        let mut props: Vec<&Proposal> = w.pending_proposals(o.id).filter(|p| p.expires_at > w.tick).collect();
        if props.is_empty() {
            continue;
        }
        let urgent = o.urgency >= 2;
        props.sort_by(|x, y| match o.side {
            Side::Buy if urgent => y.qty.cmp(&x.qty).then(cheaper(x.total, x.qty, y.total, y.qty)),
            Side::Buy => cheaper(x.total, x.qty, y.total, y.qty).then(y.qty.cmp(&x.qty)),
            // Selling: the best price per unit, then the bigger lot.
            Side::Sell => cheaper(y.total, y.qty, x.total, x.qty).then(y.qty.cmp(&x.qty)),
        });
        let field: Vec<String> = props.iter().map(|p| format!("{} {}×{}cr", w.actors.get(&p.merchant).map(|m| m.name.as_str()).unwrap_or(&p.merchant), p.qty, p.total / p.qty.max(1))).collect();
        let mut remaining = o.remaining();
        for (i, p) in props.iter().enumerate() {
            if p.qty > remaining {
                continue;
            }
            let why = if i == 0 {
                match (o.side, urgent) {
                    (Side::Buy, true) => "urgent: most coverage first, then price",
                    (Side::Buy, false) => "routine: cheapest per unit",
                    (Side::Sell, _) => "best bid per unit",
                }
            } else {
                "fills the rest of the order"
            };
            out.push(decision(id, &format!("order #{}", o.id), &[("order", o.id as i64), ("proposal", p.id as i64), ("qty", p.qty), ("total", p.total), ("competing", props.len() as i64)], Some(Action::AcceptProposal { order: o.id, proposal: p.id }), format!("Take {}'s {} {} for {} cr on #{} ({why}). On the table: {}.", w.actors.get(&p.merchant).map(|m| m.name.as_str()).unwrap_or(&p.merchant), p.qty, r.name(), p.total, o.id, field.join(", "))));
            remaining -= p.qty;
            if remaining == 0 || !o.allow_partial {
                break;
            }
        }
    }
    out
}

/// Every agent's decisions for the current state.
pub fn decide_all(w: &World) -> Vec<Decision> {
    let mut out = Vec::new();
    for (id, a) in &w.actors {
        match a.kind {
            ActorKind::Faction => {
                out.extend(commander(w, id));
                out.extend(commander_choices(w, id));
            }
            ActorKind::Merchant => {
                if *id == w.market.merchant {
                    out.extend(merchant(w));
                }
                out.extend(merchant_proposals(w, id));
            }
        }
    }
    out
}

/// Decide, then execute each proposed action in order, in three rounds: commanders
/// and merchants act on the world (placing orders among other things), then every
/// merchant answers the open orders, then each commander chooses. Each decision is
/// paired with its execution result (`None` when it proposed nothing). A rejected
/// action changes nothing; later decisions see the effect of earlier accepted ones.
pub fn run_fallback_agents(w: &mut World) -> Vec<(Decision, Option<Result<Vec<Event>, EconError>>)> {
    let mut log = Vec::new();
    let ids: Vec<(String, ActorKind)> = w.actors.iter().map(|(k, a)| (k.clone(), a.kind)).collect();
    let run = |w: &mut World, id: &str, decisions: Vec<Decision>, log: &mut Vec<_>| {
        for d in decisions {
            let r = d.action.as_ref().map(|act| w.execute(&Caller::Agent(id.to_string()), act));
            log.push((d, r));
        }
    };
    for (id, kind) in &ids {
        let d = match kind { ActorKind::Faction => commander(w, id), ActorKind::Merchant if *id == w.market.merchant => merchant(w), ActorKind::Merchant => vec![] };
        run(w, id, d, &mut log);
    }
    for (id, kind) in &ids {
        if *kind == ActorKind::Merchant {
            let d = merchant_proposals(w, id);
            run(w, id, d, &mut log);
        }
    }
    for (id, kind) in &ids {
        if *kind == ActorKind::Faction {
            let d = commander_choices(w, id);
            run(w, id, d, &mut log);
        }
    }
    log
}
