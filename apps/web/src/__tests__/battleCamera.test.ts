import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { BattleCamera } from '@/engine/camera/BattleCamera'
import { setCover } from '@/engine/sim/Cover'

// The OTS (over-the-shoulder) mode is the player's eye in the shooter duel:
// it must sit behind the player relative to the enemy, aim at the enemy, and
// report a cameraYaw that makes "W" walk straight at the enemy (the sim maps
// movement camera-relative through this yaw). Pure math — runs headless.

const DT = 1 / 60

function settle(cam: BattleCamera, player: THREE.Vector3, enemy: THREE.Vector3, frames = 600) {
  for (let i = 0; i < frames; i++) cam.update(DT, player, enemy)
}

describe('BattleCamera OTS mode', () => {
  let three: THREE.PerspectiveCamera
  let cam: BattleCamera
  const player = new THREE.Vector3(-5, 0, 0)
  const enemy = new THREE.Vector3(5, 0, 0)

  beforeEach(() => {
    setCover([]) // the module boots with a random layout — clear it for determinism
    three = new THREE.PerspectiveCamera(50)
    cam = new BattleCamera(three)
    cam.setMode('ots')
  })

  it('sits behind the player, opposite the enemy, at shoulder height', () => {
    settle(cam, player, enemy)

    // Behind = on the far side of the player from the enemy (enemy is +x).
    expect(three.position.x).toBeLessThan(player.x - 2)
    expect(three.position.x).toBeGreaterThan(player.x - 5)
    // Shoulder height, not the old 5m crane.
    expect(three.position.y).toBeGreaterThan(1.7)
    expect(three.position.y).toBeLessThan(2.5)
  })

  it('aims at the enemy: the view direction converges on the enemy chest', () => {
    settle(cam, player, enemy)

    const dir = three.getWorldDirection(new THREE.Vector3())
    const toEnemy = new THREE.Vector3(enemy.x, 1.35, enemy.z).sub(three.position).normalize()
    expect(dir.dot(toEnemy)).toBeGreaterThan(0.99)
  })

  it('cameraYaw makes controller-forward point at the enemy (W = advance)', () => {
    settle(cam, player, enemy)

    // CharacterController computes forward as (-sin yaw, -cos yaw).
    const fwd = new THREE.Vector2(-Math.sin(cam.cameraYaw), -Math.cos(cam.cameraYaw))
    const toEnemy = new THREE.Vector2(enemy.x - player.x, enemy.z - player.z).normalize()
    expect(fwd.dot(toEnemy)).toBeGreaterThan(0.99)
  })

  it('spring-arms in front of tall cover instead of putting a wall between camera and player', () => {
    // A tall pillar directly on the player→camera line (camera settles ~x=-8.4, z=+0.85).
    setCover([{ x: -7, z: 0.4, hx: 0.6, hz: 1.5, height: 2.2 }])
    settle(cam, player, enemy)

    const planar = Math.hypot(three.position.x - player.x, three.position.z - player.z)
    expect(planar).toBeLessThan(2) // pulled in from the default 3.4m arm
    expect(planar).toBeGreaterThan(1) // but never inside the player
  })

  it('killcam orbits the focused fighter at portrait distance, looking at them', () => {
    settle(cam, player, enemy) // start from the OTS shot, like a real KO
    cam.startKillcam('target') // enemy won — orbit the second update() argument

    const azimuth = () =>
      Math.atan2(three.position.x - enemy.x, three.position.z - enemy.z)

    settle(cam, player, enemy, 120) // 2s — converge onto the orbit ring
    const a1 = azimuth()
    const d1 = Math.hypot(three.position.x - enemy.x, three.position.z - enemy.z)
    expect(d1).toBeGreaterThan(2.5)
    expect(d1).toBeLessThan(4.5)

    const dir = three.getWorldDirection(new THREE.Vector3())
    const toFocus = new THREE.Vector3(enemy.x, 1.15, enemy.z).sub(three.position).normalize()
    expect(dir.dot(toFocus)).toBeGreaterThan(0.98)

    settle(cam, player, enemy, 120) // 2 more seconds — the orbit must ADVANCE
    let swept = azimuth() - a1
    while (swept > Math.PI) swept -= Math.PI * 2
    while (swept < -Math.PI) swept += Math.PI * 2
    expect(Math.abs(swept)).toBeGreaterThan(0.4) // ~0.8 rad expected at 0.4 rad/s
  })

  it('setMode(duel) returns to the wide framing that watches the midpoint (KO beat)', () => {
    settle(cam, player, enemy)
    cam.setMode('duel')
    settle(cam, player, enemy)

    const dir = three.getWorldDirection(new THREE.Vector3())
    const toMid = new THREE.Vector3(0, 1.2, 0).sub(three.position).normalize()
    expect(dir.dot(toMid)).toBeGreaterThan(0.95)
    // Duel framing is the high crane shot, clearly above the OTS shoulder cam.
    expect(three.position.y).toBeGreaterThan(4)
  })
})
