// The game's words, in one place, for the Help screen. Readiness and merchant words come from
// the presenters' own labels, and the figures from the rules the presenters use, so this page
// cannot drift from what the screens say.

import { READINESS_LABEL } from '@/lib/presenter/economy'
import { MERCHANT_LABEL } from '@/lib/presenter/merchant'
import { LOGISTICS_FUEL, STAGING_FUEL } from '@/lib/presenter/rules'

export interface Term { term: string; means: string }
export interface TermGroup { title: string; terms: Term[] }

export const GLOSSARY: TermGroup[] = [
  {
    title: 'How ready a faction is',
    terms: [
      { term: READINESS_LABEL.operational, means: 'Nothing is short. Its guards are armed, reinforcements flow and it can stage depots.' },
      { term: READINESS_LABEL.under_pressure, means: 'Something is short, or a production line is sabotaged, and nothing is on its way yet.' },
      { term: READINESS_LABEL.supply_critical, means: 'Something is critically short (no armed guards, no medicine, too little fuel to ship, or no credits to buy resupply) with nothing inbound.' },
      { term: READINESS_LABEL.rebuilding, means: 'It is short, but a real supply order or convoy for what it lacks is under way.' },
    ],
  },
  {
    title: 'How a merchant is trading',
    terms: [
      { term: MERCHANT_LABEL.trading, means: 'Shelves stocked and able to pay: it answers supply orders both ways.' },
      { term: MERCHANT_LABEL.stretched, means: 'A shelf is under target or full, so prices run higher or it will not bid on some orders.' },
      { term: MERCHANT_LABEL.constrained, means: 'A shelf is empty or it is at its credit reserve, so it cannot answer some orders at all.' },
      { term: MERCHANT_LABEL.insolvent, means: 'Below its credit reserve: it is not buying or restocking until sales recover.' },
    ],
  },
  {
    title: 'What the numbers do',
    terms: [
      { term: 'Ammunition', means: 'Arms guards: a rifle takes 8, a sidearm 2. Short of that, guards are armed with what is left, or stay home.' },
      { term: 'Medicine', means: 'Brings reinforcement waves during a raid. None means no reinforcements.' },
      { term: 'Fuel', means: `Below ${STAGING_FUEL} a faction cannot stage a forward depot, so there is nothing to raid. Below ${LOGISTICS_FUEL} its shipments are grounded.` },
      { term: 'Credits', means: 'Pay for resupply and escorts. A faction never spends below its reserve.' },
    ],
  },
  {
    title: 'The economy',
    terms: [
      { term: 'Supply order', means: 'A request posted when a faction is short or has surplus. Each merchant answers with its own offer, or declines.' },
      { term: 'Bounty', means: 'A sponsor\'s fee for a raid on a rival. It pays when you bring out at least half the manifest.' },
      { term: 'Convoy', means: 'A supply shipment on the road. It shows on the War Table only while it is moving.' },
      { term: 'Pending', means: 'Recorded but not yet confirmed. A payment is never called settled until the chain says so.' },
      { term: 'Advanced view', means: 'A switch on the Exchange and War Room that adds the contract, transaction ids and the engine\'s validation record.' },
    ],
  },
]
