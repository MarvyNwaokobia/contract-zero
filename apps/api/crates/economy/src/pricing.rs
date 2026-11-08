//! Merchant pricing rules, all in one readable place.
//!
//! A price is a pure function of the merchant's real state: how much stock it holds
//! against its target, what the resource costs to produce, and the last day of net
//! demand (units it sold minus units it bought). Every factor is bounded, so no
//! sequence of trades can push a price outside `[cost, 4 × cost]`.
//!
//! All arithmetic is integer, in credits and basis points (1 bp = 0.01%), so a
//! price is identical on every machine and replays are exact.
//!
//! ```text
//! scarcity = clamp(target / stock,                  0.5 … 3.0)
//! demand   = clamp(1 + 0.5 × net_demand_24h / target, 0.7 … 1.5)
//! mid      = clamp(cost × (1 + margin) × scarcity × demand, cost … 4 × cost)
//! ask      = mid × (1 + spread / 2)    what the merchant charges
//! bid      = mid × (1 − spread / 2)    what the merchant pays (≥ 1)
//! ```
//!
//! Quotes walk the curve one unit at a time, so a big order pays the marginal price
//! of every unit it moves: buying the last fuel in the yard costs more than the first.

use serde::{Deserialize, Serialize};

use crate::Resource;

pub const BP: i64 = 10_000;

pub const SCARCITY_MIN_BP: i64 = 5_000;
pub const SCARCITY_MAX_BP: i64 = 30_000;
pub const DEMAND_MIN_BP: i64 = 7_000;
pub const DEMAND_MAX_BP: i64 = 15_000;
/// How strongly a day of net demand moves the price, relative to target stock.
pub const DEMAND_WEIGHT_BP: i64 = 5_000;
/// Ceiling as a multiple of production cost.
pub const PRICE_CEIL_MULT: i64 = 4;

/// The merchant's adjustable strategy. An agent may change these, but only within
/// these bounds; the engine clamps whatever it is given.
pub const MARGIN_MIN_BP: i64 = 0;
pub const MARGIN_MAX_BP: i64 = 4_000;
pub const SPREAD_MIN_BP: i64 = 500;
pub const SPREAD_MAX_BP: i64 = 3_000;

/// Production cost per unit, in credits: the floor under every price.
pub fn production_cost(r: Resource) -> i64 {
    match r {
        Resource::Ammo => 12,
        Resource::Med => 30,
        Resource::Fuel => 20,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Strategy {
    pub margin_bp: i64,
    pub spread_bp: i64,
}

impl Strategy {
    pub fn clamped(self) -> Self {
        Self {
            margin_bp: self.margin_bp.clamp(MARGIN_MIN_BP, MARGIN_MAX_BP),
            spread_bp: self.spread_bp.clamp(SPREAD_MIN_BP, SPREAD_MAX_BP),
        }
    }
}

/// The inputs to one resource's price, with the factors it produced. Returned with
/// every quote so the War Room can show exactly why a price is what it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriceBreakdown {
    pub cost: i64,
    pub stock: i64,
    pub target: i64,
    pub net_demand_24h: i64,
    pub margin_bp: i64,
    pub scarcity_bp: i64,
    pub demand_bp: i64,
    pub mid: i64,
    pub ask: i64,
    pub bid: i64,
}

pub fn scarcity_bp(stock: i64, target: i64) -> i64 {
    (BP * target.max(1) / stock.max(1)).clamp(SCARCITY_MIN_BP, SCARCITY_MAX_BP)
}

pub fn demand_bp(net_demand_24h: i64, target: i64) -> i64 {
    (BP + DEMAND_WEIGHT_BP * net_demand_24h / target.max(1)).clamp(DEMAND_MIN_BP, DEMAND_MAX_BP)
}

/// Price of one unit at the given state.
pub fn price(r: Resource, stock: i64, target: i64, net_demand_24h: i64, s: Strategy) -> PriceBreakdown {
    let s = s.clamped();
    let cost = production_cost(r);
    let sc = scarcity_bp(stock, target);
    let dm = demand_bp(net_demand_24h, target);
    let raw = cost as i128 * (BP + s.margin_bp) as i128 * sc as i128 * dm as i128 / (BP as i128).pow(3);
    let mid = (raw as i64).clamp(cost, cost * PRICE_CEIL_MULT);
    let half = s.spread_bp / 2;
    let ask = div_ceil(mid * (BP + half), BP);
    let bid = (mid * (BP - half) / BP).max(1);
    PriceBreakdown { cost, stock, target, net_demand_24h, margin_bp: s.margin_bp, scarcity_bp: sc, demand_bp: dm, mid, ask, bid }
}

fn div_ceil(a: i64, b: i64) -> i64 {
    (a + b - 1) / b
}

/// Which way the counterparty trades with the merchant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    /// Counterparty buys from the merchant (merchant stock falls).
    Buy,
    /// Counterparty sells to the merchant (merchant stock rises).
    Sell,
}

/// Total for `qty` units, walking the price curve one unit at a time.
/// Returns `None` if the merchant cannot fill a buy of that size.
pub fn walk_total(r: Resource, side: Side, qty: i64, stock: i64, target: i64, net_demand_24h: i64, s: Strategy) -> Option<i64> {
    if qty <= 0 {
        return None;
    }
    if side == Side::Buy && qty > stock {
        return None;
    }
    let mut total = 0i64;
    for i in 0..qty {
        total += match side {
            Side::Buy => price(r, stock - i, target, net_demand_24h + i, s).ask,
            Side::Sell => price(r, stock + i, target, net_demand_24h - i, s).bid,
        };
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Strategy = Strategy { margin_bp: 2_000, spread_bp: 1_000 };

    #[test]
    fn at_target_with_no_demand_the_mid_is_cost_plus_margin() {
        let p = price(Resource::Fuel, 100, 100, 0, S);
        assert_eq!(p.scarcity_bp, BP);
        assert_eq!(p.demand_bp, BP);
        assert_eq!(p.mid, 24); // 20 × 1.2
        assert!(p.bid < p.mid && p.mid < p.ask);
    }

    #[test]
    fn scarcer_stock_costs_more_and_surplus_costs_less() {
        let scarce = price(Resource::Fuel, 25, 100, 0, S).mid;
        let normal = price(Resource::Fuel, 100, 100, 0, S).mid;
        let glut = price(Resource::Fuel, 400, 100, 0, S).mid;
        assert!(scarce > normal && normal >= glut);
    }

    #[test]
    fn demand_pushes_the_price_up_and_selling_pressure_down() {
        let hot = price(Resource::Ammo, 100, 100, 80, S).mid;
        let flat = price(Resource::Ammo, 100, 100, 0, S).mid;
        let cold = price(Resource::Ammo, 100, 100, -80, S).mid;
        assert!(hot > flat && flat >= cold);
    }

    #[test]
    fn every_price_stays_inside_its_bounds() {
        for r in [Resource::Ammo, Resource::Med, Resource::Fuel] {
            let c = production_cost(r);
            for stock in [0, 1, 5, 50, 500, 50_000] {
                for demand in [-10_000, -100, 0, 100, 10_000] {
                    for strat in [Strategy { margin_bp: -9_999, spread_bp: 0 }, S, Strategy { margin_bp: 99_999, spread_bp: 99_999 }] {
                        let p = price(r, stock, 100, demand, strat);
                        assert!(p.mid >= c && p.mid <= c * PRICE_CEIL_MULT, "{r:?} {stock} {demand} → {p:?}");
                        assert!(p.bid >= 1 && p.bid <= p.mid && p.mid <= p.ask);
                    }
                }
            }
        }
    }

    #[test]
    fn strategy_is_clamped_to_its_bounds() {
        let s = Strategy { margin_bp: 50_000, spread_bp: 1 }.clamped();
        assert_eq!(s, Strategy { margin_bp: MARGIN_MAX_BP, spread_bp: SPREAD_MIN_BP });
    }

    #[test]
    fn walking_the_curve_makes_large_orders_pay_marginal_prices() {
        let one = walk_total(Resource::Fuel, Side::Buy, 1, 60, 100, 0, S).unwrap();
        let fifty = walk_total(Resource::Fuel, Side::Buy, 50, 60, 100, 0, S).unwrap();
        assert!(fifty > one * 50);
        let sell_fifty = walk_total(Resource::Fuel, Side::Sell, 50, 60, 100, 0, S).unwrap();
        assert!(sell_fifty < fifty, "round-tripping must lose money to the spread");
    }

    #[test]
    fn a_buy_larger_than_stock_cannot_be_quoted() {
        assert_eq!(walk_total(Resource::Med, Side::Buy, 11, 10, 100, 0, S), None);
        assert_eq!(walk_total(Resource::Med, Side::Buy, 0, 10, 100, 0, S), None);
    }
}
