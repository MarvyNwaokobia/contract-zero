/**
 * @module fps/nav
 * @description Grid navigation for enemies on levels with real structure (buildings,
 * corridors, container rows). Without it a guard steers straight at its goal and pins
 * itself against the first wall between them; with it, it walks round through the
 * doorway like a person would.
 *
 * The grid marks every cell whose centre lies inside a collider inflated by the body
 * radius, so a free cell is one a body can stand in. Paths are A* over 8-neighbours
 * (no corner cutting), then string-pulled so guards walk straight lines between turns
 * instead of a staircase. Pure and deterministic: same colliders, same paths.
 */

import type { CoverBox } from './FpsSim'

export interface NavBounds { minX: number; maxX: number; minZ: number; maxZ: number }

export class NavGrid {
  readonly cols: number
  readonly rows: number
  private readonly blocked: Uint8Array

  constructor(readonly bounds: NavBounds, boxes: readonly CoverBox[], readonly radius: number, readonly cell = 0.5) {
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell))
    this.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell))
    this.blocked = new Uint8Array(this.cols * this.rows)
    for (const b of boxes) {
      const x0 = b.x - b.w / 2 - radius, x1 = b.x + b.w / 2 + radius
      const z0 = b.z - b.d / 2 - radius, z1 = b.z + b.d / 2 + radius
      const c0 = Math.max(0, Math.floor((x0 - bounds.minX) / cell)), c1 = Math.min(this.cols - 1, Math.floor((x1 - bounds.minX) / cell))
      const r0 = Math.max(0, Math.floor((z0 - bounds.minZ) / cell)), r1 = Math.min(this.rows - 1, Math.floor((z1 - bounds.minZ) / cell))
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const cx = bounds.minX + (c + 0.5) * cell, cz = bounds.minZ + (r + 0.5) * cell
          if (cx > x0 && cx < x1 && cz > z0 && cz < z1) this.blocked[r * this.cols + c] = 1
        }
      }
    }
  }

  private col(x: number) { return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.bounds.minX) / this.cell))) }
  private row(z: number) { return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.bounds.minZ) / this.cell))) }
  private cx(c: number) { return this.bounds.minX + (c + 0.5) * this.cell }
  private cz(r: number) { return this.bounds.minZ + (r + 0.5) * this.cell }

  isFree(x: number, z: number): boolean {
    if (x < this.bounds.minX || x > this.bounds.maxX || z < this.bounds.minZ || z > this.bounds.maxZ) return false
    return this.blocked[this.row(z) * this.cols + this.col(x)] === 0
  }

  /** Can a body walk straight from a to b? (Samples the segment at half-cell steps.) */
  segmentClear(ax: number, az: number, bx: number, bz: number): boolean {
    const len = Math.hypot(bx - ax, bz - az)
    const n = Math.max(1, Math.ceil(len / (this.cell * 0.5)))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      if (!this.isFree(ax + (bx - ax) * t, az + (bz - az) * t)) return false
    }
    return true
  }

  /** The free cell nearest to (x, z), searching outward ring by ring. */
  private nearestFree(x: number, z: number): number | null {
    const c0 = this.col(x), r0 = this.row(z)
    if (this.blocked[r0 * this.cols + c0] === 0) return r0 * this.cols + c0
    for (let ring = 1; ring < 12; ring++) {
      let best: number | null = null
      let bestD = Infinity
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue
          if (this.blocked[r * this.cols + c]) continue
          const d = Math.hypot(this.cx(c) - x, this.cz(r) - z)
          if (d < bestD) { bestD = d; best = r * this.cols + c }
        }
      }
      if (best !== null) return best
    }
    return null
  }

  /**
   * Waypoints from a to b (excluding the start, ending at b or the nearest reachable
   * point to it), or null if b is unreachable. Bounded so a bad query can't stall a
   * frame.
   */
  findPath(ax: number, az: number, bx: number, bz: number, maxNodes = 6000): [number, number][] | null {
    const start = this.nearestFree(ax, az)
    const goal = this.nearestFree(bx, bz)
    if (start === null || goal === null) return null
    if (start === goal) return [[bx, bz]]
    const N = this.cols * this.rows
    const g = new Float32Array(N).fill(Infinity)
    const from = new Int32Array(N).fill(-1)
    const closed = new Uint8Array(N)
    const gc = goal % this.cols, gr = (goal / this.cols) | 0
    const h = (i: number) => {
      const dc = Math.abs((i % this.cols) - gc), dr = Math.abs(((i / this.cols) | 0) - gr)
      return (dc + dr + (Math.SQRT2 - 2) * Math.min(dc, dr)) * this.cell
    }
    // Binary heap of [f, node].
    const heap: [number, number][] = [[h(start), start]]
    const push = (f: number, n: number) => {
      heap.push([f, n])
      let i = heap.length - 1
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p }
    }
    const pop = (): [number, number] => {
      const top = heap[0], last = heap.pop()!
      if (heap.length) {
        heap[0] = last
        let i = 0
        for (;;) {
          const l = 2 * i + 1, r = l + 1
          let m = i
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r
          if (m === i) break
          ;[heap[m], heap[i]] = [heap[i], heap[m]]
          i = m
        }
      }
      return top
    }
    g[start] = 0
    let expanded = 0
    while (heap.length && expanded < maxNodes) {
      const [, cur] = pop()
      if (closed[cur]) continue
      closed[cur] = 1
      expanded++
      if (cur === goal) break
      const c = cur % this.cols, r = (cur / this.cols) | 0
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue
          const nc = c + dc, nr = r + dr
          if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue
          const n = nr * this.cols + nc
          if (this.blocked[n] || closed[n]) continue
          // No corner cutting: a diagonal needs both orthogonal neighbours free.
          if (dr && dc && (this.blocked[r * this.cols + nc] || this.blocked[nr * this.cols + c])) continue
          const ng = g[cur] + (dr && dc ? Math.SQRT2 : 1) * this.cell
          if (ng < g[n]) { g[n] = ng; from[n] = cur; push(ng + h(n), n) }
        }
      }
    }
    if (from[goal] === -1) return null
    const cells: number[] = []
    for (let n = goal; n !== start && n !== -1; n = from[n]) cells.push(n)
    cells.reverse()
    const pts: [number, number][] = cells.map((n) => [this.cx(n % this.cols), this.cz((n / this.cols) | 0)])
    // Finish at the exact goal when it is standable.
    if (this.isFree(bx, bz)) pts[pts.length - 1] = [bx, bz]
    // String-pull: drop every waypoint the previous kept point can see past.
    const out: [number, number][] = []
    let ox = ax, oz = az
    for (let i = 0; i < pts.length; i++) {
      const next = pts[i + 1]
      if (next && this.segmentClear(ox, oz, next[0], next[1])) continue
      out.push(pts[i])
      ox = pts[i][0]; oz = pts[i][1]
    }
    return out
  }
}
