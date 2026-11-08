import { describe, it, expect } from 'vitest'
import { normalizeBoneTrackName } from '@/engine/animation/MixamoLoader'

// Regression guard for the recurring T-pose bug. The Mixamo clip tracks must be
// renamed to EXACTLY match the GLB rig's bone names, or THREE.PropertyBinding finds
// no target node, zero tracks bind, and the fighter is stuck in its bind-pose
// T-pose. The trap: three's GLTFLoader sanitizes node names and STRIPS the ":" from
// Blender's "mixamorig:Hips", so the live bone is "mixamorigHips" (colon-less). An
// earlier version INJECTED a ":" into the track names → nothing bound on any device.
describe('Mixamo → GLB bone-track binding', () => {
  // The real bone names the GLB rigs expose at runtime (post GLTFLoader sanitize),
  // captured from the deployed build's console.
  const RIG_BONES = [
    'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigNeck',
    'mixamorigHead', 'mixamorigLeftArm', 'mixamorigRightArm', 'mixamorigRightHand',
    'mixamorigRightForeArm', 'mixamorigLeftUpLeg', 'mixamorigRightToeBase',
  ]

  it('renames every FBX track to a name the GLB rig actually exposes', () => {
    for (const bone of RIG_BONES) {
      // FBXLoader emits "<bone>.<property>"; normalization must leave the node part
      // exactly equal to the rig bone so PropertyBinding can resolve it.
      const node = normalizeBoneTrackName(`${bone}.quaternion`).split('.')[0]
      expect(RIG_BONES, `track "${bone}" must bind to a rig bone`).toContain(node)
    }
  })

  it('never injects a colon (the bug that broke binding on every device)', () => {
    expect(normalizeBoneTrackName('mixamorigHips.quaternion')).toBe('mixamorigHips.quaternion')
    expect(normalizeBoneTrackName('mixamorigHips.quaternion')).not.toContain(':')
  })

  it('collapses a colon-prefixed bone (Blender export) to the colon-less rig form', () => {
    expect(normalizeBoneTrackName('mixamorig:Spine.scale')).toBe('mixamorigSpine.scale')
  })

  it('strips a numbered duplicate skeleton ("mixamorig2Hips") down to the base rig', () => {
    expect(normalizeBoneTrackName('mixamorig2Hips.position')).toBe('mixamorigHips.position')
  })

  it('preserves the property suffix untouched', () => {
    expect(normalizeBoneTrackName('mixamorigLeftToeBase.quaternion'))
      .toBe('mixamorigLeftToeBase.quaternion')
  })
})
