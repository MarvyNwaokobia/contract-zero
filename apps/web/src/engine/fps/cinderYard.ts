/**
 * CINDER YARD: the Ashen Compact's refinery. A third environment, built for it.
 *
 * South to north (+z is the way in):
 *  - The road and the security checkpoint (z 12…19): a guard booth, barriers, the
 *    gate in the perimeter fence. The Compact's flatbed waits on the road outside.
 *  - The tank farm (z 10…-16): four storage tanks in two pairs, pipe racks and pump
 *    skids between them, a tanker parked at the loading arm. Wide lanes, long sight
 *    lines down the middle, hard cover at the tanks.
 *  - The blast wall (z = -18): a main gap on the road and a narrow maintenance
 *    passage at the west fence.
 *  - The processing deck (z -20…-56): two fractionation columns joined by pipe bridges
 *    and catwalks overhead, the loading bay in the middle, the arms shed to the west
 *    (racks, one door), the control room to the east (desks and servers, one door),
 *    the flare stack burning in the north-east corner. The owner's truck waits at
 *    the east fence for a handover.
 *
 * Sabotage hits the refinery's own infrastructure: the crude manifold at the tank farm
 * and the base of a fractionation column on the processing deck.
 */

import type { Box, LevelDef } from './levels'

const H = 3.2
const fence = (x: number, z: number, w: number, d: number): Box => ({ x, z, w, d, h: 3, kind: 'fence' })
const wall = (x: number, z: number, w: number, d: number, h = 3.6): Box => ({ x, z, w, d, h, kind: 'concrete' })
const inner = (x: number, z: number, w: number, d: number): Box => ({ x, z, w, d, h: H, kind: 'interior' })
const tank = (x: number, z: number, r: number, h: number): Box => ({ x, z, w: r, d: r, h, kind: 'tank' })
const column = (x: number, z: number): Box => ({ x, z, w: 3, d: 3, h: 16, kind: 'column' })
const rack = (x: number, z: number, w: number, d: number): Box => ({ x, z, w, d, h: 1.3, kind: 'pipe_rack' })
const skid = (x: number, z: number, w = 2.2, d = 1.4): Box => ({ x, z, w, d, h: 1.3, kind: 'pump' })
const barrier = (x: number, z: number, w: number, d: number): Box => ({ x, z, w, d, h: 1.1, kind: 'barrier' })

export const CINDER_YARD: LevelDef = {
  id: 'cinder_yard',
  name: 'Cinder Yard Refinery',
  region: 'Refinery flats',
  start: [0, 16.5],
  bounds: { minX: -33, maxX: 33, minZ: -58, maxZ: 20 },
  walls: [
    // perimeter: south fence with the gate (x -4…4), sides, the north wall
    fence(-18.5, 12, 29, 0.2), fence(18.5, 12, 29, 0.2),
    fence(-33, -23, 0.2, 70), fence(33, -23, 0.2, 70),
    wall(0, -57.5, 66, 1, 4.2),
    // the blast wall between the tank farm and the processing deck: the main gap on the
    // road (x -4…4) and the maintenance passage at the west fence (x -30…-26.5)
    wall(-15.25, -18, 22.5, 1), wall(18.5, -18, 29, 1), wall(-31.6, -18, 2.8, 1),
    // arms shed (west): door in the south wall at x -25…-22
    inner(-28.25, -38, 5.5, 0.3), inner(-20, -38, 4, 0.3), inner(-24, -52, 12, 0.3),
    inner(-30, -45, 0.3, 14), inner(-18, -45, 0.3, 14),
    // control room (east): door in the south wall at x 21…24
    inner(18.5, -36, 5, 0.3), inner(27, -36, 6, 0.3), inner(23, -50, 14, 0.3),
    inner(16, -43, 0.3, 14), inner(30, -43, 0.3, 14),
  ],
  cover: [
    // checkpoint
    { x: 7, z: 15.5, w: 2.4, d: 2.4, h: 3, kind: 'booth' },
    barrier(-6.5, 14, 3, 0.7), barrier(-9, 17, 3, 0.7),
    // tank farm: two pairs of storage tanks
    tank(-20, 3, 7, 8), tank(-20, -8, 7, 8), tank(17, 3, 6, 7), tank(17, -8, 6, 7),
    // pipe racks and pump skids between them
    rack(-7, -3, 9, 0.9), rack(6, 0, 8, 0.9), rack(-1, -12, 0.9, 6),
    skid(-6, 6.5), skid(6.5, 7), skid(-11, -10),
    // the tanker at the loading arm
    { x: 9.5, z: -11.5, w: 2.6, d: 8, h: 3, kind: 'truck' },
    // processing deck: fractionation columns and their bund
    column(-7, -30), column(7, -30),
    barrier(0, -34.5, 5, 0.7), barrier(-12, -41, 0.7, 4), barrier(12, -44, 0.7, 4),
    // containers staged by the loading bay
    { x: 12, z: -24, w: 6, d: 2.4, h: 2.6, kind: 'container', color: '#7a3b26' },
    { x: -12.5, z: -27, w: 2.4, d: 6, h: 2.6, kind: 'container', color: '#5b5f63' },
    // loading bay: pallets and crates around the staged cargo
    { x: -5, z: -42.5, w: 1.4, d: 1.4, h: 1.1, kind: 'case' }, { x: 5, z: -42.5, w: 1.4, d: 1.4, h: 1.1, kind: 'case' },
    { x: -5.5, z: -51, w: 2, d: 1.2, h: 1.2, kind: 'crate' }, { x: 5.5, z: -51, w: 2, d: 1.2, h: 1.2, kind: 'crate' },
    // inside the arms shed and the control room
    { x: -27, z: -46, w: 0.9, d: 6, h: 2.6, kind: 'rack' }, { x: -21, z: -46, w: 0.9, d: 6, h: 2.6, kind: 'rack' },
    { x: 23, z: -46.5, w: 4, d: 0.8, h: 0.9, kind: 'desk' }, { x: 28.5, z: -40, w: 0.8, d: 2.2, h: 2.2, kind: 'server' },
    // drums stacked by the pump skids, and by the arms shed door
    { x: -3.2, z: 6.8, w: 0.6, d: 0.6, h: 0.95, kind: 'drum' }, { x: -2.4, z: 7.4, w: 0.6, d: 0.6, h: 0.95, kind: 'drum' }, { x: -3.0, z: 7.7, w: 0.6, d: 0.6, h: 0.95, kind: 'drum' },
    { x: -19.6, z: -35.2, w: 0.6, d: 0.6, h: 0.95, kind: 'drum' }, { x: -18.8, z: -35.2, w: 0.6, d: 0.6, h: 0.95, kind: 'drum' },
    // control room: consoles and a lockers bank
    { x: 28.4, z: -46, w: 0.9, d: 3.4, h: 1.0, kind: 'console' }, { x: 17, z: -48, w: 0.7, d: 2.4, h: 1.9, kind: 'locker' },
    // north-east: the flare stack's base
    { x: 25, z: -53, w: 2.6, d: 2.6, h: 2.4, kind: 'concrete' },
  ],
  art: [
    { kind: 'road', x: 0, z: 2, w: 7, d: 36 },
    { kind: 'stripe', x: 0, z: 12.2, w: 8, d: 0.25 },
    { kind: 'light_pole', x: -12, z: 9 }, { kind: 'light_pole', x: 11, z: -15 }, { kind: 'light_pole', x: -2, z: -40 },
    { kind: 'pipe', x: 0, z: -30, w: 11, h: 7 }, { kind: 'pipe', x: 0, z: -31.2, w: 11, h: 9.5 },
    { kind: 'pipe', x: -20, z: -2.5, w: 0.6, d: 4, h: 4.5 }, { kind: 'pipe', x: 17, z: -2.5, w: 0.6, d: 5, h: 4 },
    { kind: 'pipe', x: -13, z: -3, w: 7, h: 3.2 }, { kind: 'pipe', x: 11, z: 0, w: 6, h: 3.2 },
    { kind: 'catwalk', x: 0, z: -28.5, w: 11, h: 5.5, d: 1.2 },
    { kind: 'catwalk', x: -7, z: -24, w: 1.2, h: 5.5, d: 8 },
    { kind: 'roof', x: 0, z: -46.5, w: 14, d: 11, h: 6.5 },
    { kind: 'roof', x: -24, z: -45, w: 12.4, d: 14.4, h: 3.4 },
    { kind: 'roof', x: 23, z: -43, w: 14.4, d: 14.4, h: 3.4 },
    { kind: 'stack', x: 25, z: -53, h: 22 },
    { kind: 'steam', x: -11, z: -13 }, { kind: 'steam', x: 21.5, z: -13 }, { kind: 'steam', x: 3, z: -33 },
    { kind: 'steam', x: -7.5, z: -3.4 }, { kind: 'steam', x: 17, z: -5 },
    // valve wheels on the pipework, and the manifold's marker
    { kind: 'valve', x: -13, z: -3, h: 3.4 }, { kind: 'valve', x: 11, z: 0, h: 3.4 }, { kind: 'valve', x: 0, z: -30, h: 7.2 },
    { kind: 'sign', x: 0, z: 12.4, h: 3.2, w: 5, color: '#ffb020' },
    { kind: 'beacon', x: 7, z: 17, h: 3.4, color: '#ffb020' }, { kind: 'beacon', x: -7, z: -28, h: 16.4 }, { kind: 'beacon', x: 7, z: -28, h: 16.4 },
    { kind: 'lamp', x: 23, z: -43, h: 3.2 }, { kind: 'lamp', x: -24, z: -45, h: 3.2 },
    { kind: 'camera', x: 6, z: 13.3, h: 3.2 },
  ],
  lights: [
    { pos: [0, 7, 6], color: '#ffb35c', intensity: 26, distance: 22 },     // sodium over the tank farm
    { pos: [0, 7, -30], color: '#ffa04a', intensity: 30, distance: 24 },   // the columns
    { pos: [25, 18, -53], color: '#ff7a2a', intensity: 40, distance: 30 }, // the flare
    { pos: [23, 3, -43], color: '#9fd0ff', intensity: 8, distance: 10 },   // control room screens
  ],
  rooms: {
    1: [{ x: [-28, -6], z: [-15, 9] }, { x: [3, 28], z: [-15, 9] }],
    2: [{ x: [-16, 14], z: [-54, -21] }, { x: [16.5, 29.5], z: [-49.5, -36.5] }, { x: [-29.5, -18.5], z: [-51.5, -38.5] }],
  },
  points: {
    entry: [0, 9], push: [0, -20.5], cargo: [0, -46.5], extract: [-16, 16.5],
    charges: [[12.4, 3], [-7, -27.6]],   // the crude manifold · a fractionation column
    cache: [23.5, -44], handover: [28, -22],
  },
  field: {
    cases: [[-1.5, -46], [1.5, -46], [-1.5, -47.7], [1.5, -47.7]],
    seized: [23.5, -44],
    ammo: [[-10, 4], [23, -13], [-24, -44], [6, -55]],
    med: [[3, 4], [-13, -53]],
    exfil: { pos: [-16, 16.5], radius: 4, vehicle: { pos: [-16, 19.2], rot: Math.PI / 2, kind: 'flatbed' } },
    handover: { pos: [27.5, -22], radius: 4, vehicle: { pos: [30.6, -22], rot: 0, kind: 'truck' } },
  },
  floor: { kind: 'concrete' },
  shadowHalf: 50,
}
