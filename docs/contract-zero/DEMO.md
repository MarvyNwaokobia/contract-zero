# CONTRACT ZERO: the demo

The brief's §17 run, in 13 steps. It plays as a game first. The fact that the economy and the agents are real is the second reveal, not the first thing you see.

There are two ways to run it:
- **By hand, recorded:** the run judges should see. Use the script below.
- **Automated, recorded:** `apps/web/demo-run.mjs` walks the same steps against the live system, checks each one, and writes a video, a screenshot per step and a `report.json`. Use it to rehearse, and as evidence that every step works.

## Before recording

1. The API and web app are running. The API needs `apps/api/.env` with the NEAR keys; the web app runs with `npx next dev -p 3000`.
2. The settlement queue is clear: the War Room header shows "0 in flight".
3. The board has at least one raid with a bounty, plus a sabotage or recovery. If not, leave the world running for a few game hours; Ashen and Vex post contracts on their own.
4. Optional: NEAR AI credits. With them, the War Room shows NEAR AI decisions and broadcasts, and briefings are model-voiced. Without them, everything still works on the deterministic agents and authored lines.
5. Screen recorder at 1280×720 or larger, with system audio on so the radio static is captured.

## The script (about 8 minutes)

| § | Do | Say or show |
|---|---|---|
| 1 | Open the site and click **Continue with Google**. | "A Google account. No wallet, no seed phrase." A NEAR account is created behind it. |
| 2 | Choose a callsign, then land on the **Hub**. | The hangar, operator, stash and world status, all live data. |
| 3 | Open **Contracts**: the clock at the top, then a raid with a bounty → **View intel**. | Each contract sits at a real site (Dustline Depot, Blacksite, Cinder Yard); the hour sets the conditions there. The intel shows the map, objectives, resistance and rewards before anything is chosen. |
| 4 | Back on the board, point out the three kinds. | A raid takes cargo; a sabotage destroys stock and halts production for 36 hours; a recovery returns stolen goods. Each has different objectives, objects and exit. |
| 5 | **Accept and get briefed**. The briefing types out. Then **Choose loadout**, pick an owned weapon, **Deploy**. | The sponsor's reason is the faction AI's own logged rationale. The weapon is checked against the player's NEAR balance. |
| 6 | Play the raid: take ammunition from a crate (E), clear the motor pool, hold E on the cargo cases. | Finite ammunition, real cases. Carrying them slows you, and the HUD shows what you carry. The target comes on the channel in its own voice. |
| 7 | At the flatbed, press E to call extraction and hold the zone. Results screen. | Only the cases carried out count: the result names them, and the debrief says what the raid did to the target's stock. |
| 8 | Wait for **Settled on NEAR testnet** and click the transaction. | The cargo is now a token in the player's own account on `assets.contract-zero.testnet`. |
| 9 | **Exchange**: sell part of the haul to Vex. | Vex is an autonomous merchant: prices move with its stock, and it can decline to buy. With quick trade on, the sale goes on chain without a prompt. |
| 10 | Wait a game hour or two (a minute or two of real time). | The raided faction reacts on its own: posture, restocking, bounties on rivals. |
| 11 | War Room header and the results link. | Only "Settled on NEAR" means a confirmed transaction. |
| 12 | **War Room**, filter **operations**, open the raid's chain. | Trigger → observed state → proposal → validation → transaction → world consequence → gameplay consequence. Then filter **NEAR AI** if the planner has credits. |
| 13 | Back to **Contracts**. | The same depot now carries a different haul, guard count or bounty, or it's gone and something else is on the board. |

Close on the Observer Mode panel, clearly labelled SIMULATION: "run the economy forward a week".

## What the automated run does differently

It says so in its header:
- It signs in with the test player's own key (a signed challenge, the wallet path), not the Google pop-up.
- It opens quick trade with that key, using the same two transactions a wallet approves.
- It flies the fight with the scene's dev hooks. The server still measures the mission time and rejects a run faster than the mission physically takes, so the script waits that out.
- It never fast-forwards the world clock: step 10 waits for the live tick.

```
cd apps/web
node demo-run.mjs http://127.0.0.1:3000 http://127.0.0.1:8080 ./demo-out
```

## Known gaps in the demo

- **Cinder Yard** has no map of its own yet; it plays on the depot layout and the intel says so.
- **§1:** Google sign-in needs the NEAR Auth / Auth0 configuration in `apps/web/.env.local` (see `AUTH.md`). Wallet sign-in works without it.
- **The NEAR AI planner** needs credits on the NEAR AI Cloud account. Without them the agents run deterministic policies, and the War Room says so.
