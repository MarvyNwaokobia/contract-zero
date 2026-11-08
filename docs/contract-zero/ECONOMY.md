# CONTRACT ZERO economy

The economy is a deterministic, integer-only world implemented in [`apps/api/crates/economy`](../../apps/api/crates/economy). Time advances in ticks of one in-game hour (24 per day).

## Assets and accounts

| Asset | Unit |
|---|---|
| Credits | the in-world currency |
| Ammunition, medical supplies, fuel | resources, in whole units |

Accounts:
- `faction:ironveil`
- `merchant:vex`
- `player:<near-account>`
- `convoy:<id>`: cargo in transit
- `escrow:<contract>`: a posted bounty
- `world`

Value moves only through `World::apply`, which checks a batch's net effect on every account before committing any of it. Either the whole command happens or none of it does, and no account except `world` can go negative.

**Conservation.** `world` is the single source and sink. For every asset, the sum of all balances, `world` included, is always zero. `world`'s balance is minus the net amount ever issued. The tests check this every tick over a simulated week of agent activity and raids.

## Issuance (sources)

| Source | Amount (genesis config) |
|---|---|
| Starting balances | Ironveil: 4,000 cr, 100 ammo, 30 med, 200 fuel. Vex: 3,000 cr, 80 ammo, 50 med, 60 fuel |
| Ironveil territory income | 960 credits / day |
| Ironveil factory | 72 ammunition / day |
| Ironveil depot convoys | 60 fuel per convoy, every 12 ticks, minted into the convoy at dispatch |
| Vex import caravans | up to 40 med per caravan, every 24 ticks, minted at dispatch |

## Sinks

| Sink | Amount |
|---|---|
| Ironveil operations | 24 ammunition, 12 medical supplies, 96 fuel / day. Only stock that exists is consumed: a gap is recorded as a shortage, never a negative balance |
| Escort wages | paid per convoy at dispatch, by defense level: L1 0, L2 80, L3 200, L4 360, L5 560 credits. An actor that can't afford its chosen level drops to the best one it can |
| Import cost | Vex pays 60% of production cost per caravan unit |

## Transfers (no issuance)

- **Trades** with Vex: credits one way, units the other.
- **Contract escrow:** the issuer's credits move into `escrow:<contract>` when a contract is posted.
- **A settled raid:** the escrowed bounty goes to the player, and the convoy's cargo goes to the issuer.
- **An unraided convoy:** it arrives, the cargo goes to its owner, and the escrowed bounty is refunded to the issuer.

## Pricing

The rules live in [`pricing.rs`](../../apps/api/crates/economy/src/pricing.rs). A price is a pure function of Vex's real state:

```text
scarcity = clamp(target / stock,                   0.5 … 3.0)
demand   = clamp(1 + 0.5 × net_demand_24h / target, 0.7 … 1.5)
mid      = clamp(cost × (1 + margin) × scarcity × demand, cost … 4 × cost)
ask      = mid × (1 + spread / 2)     what Vex charges
bid      = mid × (1 − spread / 2)     what Vex pays (≥ 1)
```

- **Production cost per unit:** ammunition 12, medical supplies 30, fuel 20.
- **Target stock:** 120 / 60 / 120.
- **Margin and spread:** Vex can set these, but only within 0–40% and 5–30%.
- **Large orders:** quotes walk the curve one unit at a time, so a big order pays the marginal price of every unit it moves.
- **Stale quotes:** every trade carries a price limit. An order placed on an out-of-date quote is rejected rather than filled at a worse price.

## Contracts

- **Bounty range:** a bounty must fall between 25% and 150% of the convoy cargo's value at production cost.
- **One contract per convoy:** a convoy carries at most one live contract.
- **One player at a time:** a contract is held by one player at a time, and settling it twice is rejected.

## Agents

Each NPC proposes actions; the engine validates every one like any other command.

| Agent | Allowed actions |
|---|---|
| Ironveil (commander) | trade, post contracts, configure defense |
| Vex (merchant) | post contracts, set its pricing strategy |

**Fallback policies.** These run when the LLM planner is unavailable ([`policy.rs`](../../apps/api/crates/economy/src/policy.rs)):
- **Ironveil:**
  - Buys up to its two-day requirement of each resource it consumes.
  - Sells surplus ammunition.
  - Raises convoy defense by one level per raid in the last 48 ticks.
  - Bounties Vex's caravans when its own medical stock is short.
- **Vex:**
  - Bounties Ironveil fuel convoys while its fuel is under target, paying more against better-defended convoys.
  - Widens its margin when any shelf is below half its target.
