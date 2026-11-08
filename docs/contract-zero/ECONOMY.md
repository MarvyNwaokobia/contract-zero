# CONTRACT ZERO economy

The economy is a deterministic, integer-only world implemented in [`apps/api/crates/economy`](../../apps/api/crates/economy). Time advances in ticks of one in-game hour (24 per day). The same seed and commands always produce the same world.

## Actors and assets

| Actor | Kind | Role |
|---|---|---|
| **Vanguard** | faction | runs depots and supply shipments; its commander buys supplies and sets defenses |
| **Vex Exchange** | merchant | the market: prices every trade, sponsors bounties, restocks by caravan |
| **Players** | NEAR accounts | raid depots, keep what they extract, trade with Vex |

**Assets:** credits, ammunition, medical supplies, fuel. Accounts: `faction:vanguard`, `merchant:vex`, `player:<near-account>`, `convoy:<id>` (a shipment in transit), `escrow:<bounty>`, and `world`.

## Conservation

Value moves only through `World::apply`, which checks a batch's net effect on every account before committing any of it. Either the whole command happens or none of it does, and no account except `world` can go negative.

- **`world` is the only source and sink.** For every asset, all balances (`world` included) sum to zero.
- **Issuance and destruction are classified per ledger entry and totalled separately from transfers.** `world`'s balance always equals destroyed − issued. Tests check both every tick over a simulated week.
- **A raid never creates goods.** It pays what the depot still holds, up to its manifest, and can be settled once.

## Sources (issuance)

| Source | Genesis config |
|---|---|
| Starting balances | Vanguard: 4,000 cr, 100 ammo, 30 med, 120 fuel. Vex: 3,000 cr, 100 ammo, 50 med, 60 fuel |
| Vanguard income | 960 credits / day |
| Vanguard factory | 48 ammunition / day |
| Vanguard supply shipments | 60 fuel each, every 12 ticks, arriving 6 ticks later |
| Vex import caravans | up to 30 med each, every 24 ticks, sized to what Vex can afford above its reserve |

## Sinks (destruction)

| Sink | Amount |
|---|---|
| Vanguard operations | 24 ammo, 12 med, 48 fuel / day. Only existing stock is consumed: a gap is a shortage, never a negative balance |
| Logistics | 10 fuel per supply shipment. Below that, the shipment is grounded |
| Escort wages | per shipment by defense level: L1 0, L2 80, L3 200, L4 360, L5 560 cr |
| Import cost | Vex pays 60% of production cost per caravan unit |

## Transfers

- **Trades** with Vex: credits one way, units the other.
- **Raids:** the depot's cargo goes from the faction to the player.
- **Bounties:** the sponsor's credits sit in escrow, then go to the raider or back to the sponsor after 24 ticks.

## Economy → battlefield

One rule per resource ([`mission.rs`](../../apps/api/crates/economy/src/mission.rs)). The server computes the raid plan and the client builds exactly that mission.

| Resource | Effect on the next raid |
|---|---|
| **Ammunition** | Guards called for: 5 + 2 × defense. Each rifle guard needs 8 ammo and each sidearm guard 2 (sidearms deal 45% damage). Rifles are issued first; a guard who can't be armed doesn't deploy. Guards draw on stock *outside* the raided depot |
| **Medicine** | Reinforcements per drop during the cargo hold: med ≥ requirement → 2 (3 at defense ≥ 4); short → 1; none → 0 |
| **Fuel** | A depot can only be staged with ≥ 20 fuel. No fuel means no raid target, and no supply shipments |

**Depot size:** 60% of the faction's stock of that resource. A depot under 10 units isn't offered.

**Guard HP:** rises 12% per defense level above 1.

## Pricing

The rules live in [`pricing.rs`](../../apps/api/crates/economy/src/pricing.rs):

```text
scarcity = clamp(target / stock,                    0.5 … 3.0)
demand   = clamp(1 + 0.5 × net_demand_24h / target, 0.7 … 1.5)
mid      = clamp(cost × (1 + margin) × scarcity × demand, cost … 4 × cost)
ask      = mid × (1 + spread / 2)     what Vex charges
bid      = mid × (1 − spread / 2)     what Vex pays (≥ 1)
```

- **Production cost per unit:** ammo 12, med 30, fuel 20.
- **Target stock:** 120 / 60 / 120.
- **Margin and spread:** Vex sets these within 0–40% and 5–30%.
- **Large orders:** quotes walk the curve per unit.
- **Stale quotes:** every trade carries a price limit. An order on a stale quote is rejected rather than filled worse.

**Insolvency.** Below its credit reserve Vex stops buying from anyone and stops restocking, but keeps selling so it can recover.

## Agents

Every proposed action is validated by the engine like any other command; a rejected one changes nothing. Agents act on the world clock whether or not anyone is playing.

| Agent | May | Fallback policy ([`policy.rs`](../../apps/api/crates/economy/src/policy.rs)) |
|---|---|---|
| **Vanguard commander** | trade, configure defense, post bounties | Keeps each resource at its two-day requirement (for ammo, plus enough to arm half its planned guards with rifles). On a shortage it quotes Vex and buys the largest amount within its spending policy (credits above its reserve). If Vex has none or it can't afford any, it records why and doesn't buy. Raises defense one level per raid in the last 48 h; cuts escorts to minimum if the treasury is below reserve |
| **Vex merchant** | set strategy, post bounties | Suspends business while insolvent. Otherwise it sponsors raids on Vanguard depots of anything its shelves are short of (40% of the depot's value, within its budget), and widens its margin while any shelf is under half its target |

Each decision is logged with its trigger, the figures it saw, the proposed action, a one-line rationale and the validation result.
