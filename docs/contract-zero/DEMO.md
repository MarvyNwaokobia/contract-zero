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
| 3 | Open **Contracts**, pick the raid with a bounty, then **Deploy**. The briefing types out. | The sponsor's reason is the faction AI's own logged rationale for posting this contract. |
| 4 | Back on the board before deploying, point out the three kinds. | A raid takes cargo; a sabotage destroys stock and halts production for 36 hours; a recovery returns stolen goods. Each has different objectives and a different route. |
| 5 | **Armory**: pick a weapon, then **Deploy**. | Dustline Depot by day, Blacksite at night: different maps and lighting. |
| 6 | Play the raid. | The radio follows the fight. The target faction comes on the channel in its own voice, and remembers you if you've hit it before. |
| 7 | Extract. Results screen. | The debrief, and what the raid did to the target's stock. |
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

- **§5, "equip owned items":** the loadout is standard issue. Owned gear, as tokens, is Milestone 7 and not yet built.
- **§1:** Google sign-in needs the NEAR Auth / Auth0 configuration in `apps/web/.env.local` (see `AUTH.md`). Wallet sign-in works without it.
- **The NEAR AI planner** needs credits on the NEAR AI Cloud account. Without them the agents run deterministic policies, and the War Room says so.
