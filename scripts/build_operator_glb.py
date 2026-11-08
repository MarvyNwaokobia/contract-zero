"""
Valor — build the Valor operator rig (the plan slice 7b)

The Slim Shooter Pack's `X Bot.fbx` is legacy FBX 6100, which Blender cannot
import. Every *animation* in the pack is modern FBX 7700 and imports fine, and
we already ship Mixamo-derived skinned GLBs. So: take an existing skinned GLB as
the BODY, graft the rifle clips onto its skeleton, export one operator.glb.

The body is a placeholder — swapping it later is a single asset change, because
the clip names and the skeleton stay put.

Bone names can drift across the FBX -> Blender -> glTF round trip (`mixamorig:Hips`
vs `mixamorigHips`). We normalise and rewrite each action's fcurve data paths so
the clips actually bind instead of silently doing nothing.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python scripts/build_operator_glb.py -- <body.glb> <anim_dir> <out.glb>
"""

import bpy
import os
import re
import sys

# clip name -> source fbx (animation-only, all FBX 7700)
ANIMS = {
    'idle':    'aim_idle.fbx',    # rifle shouldered — reads as the aim telegraph
    'walk':    'walking.fbx',
    'run':     'rifle_run.fbx',
    'strafeL': 'strafe_a.fbx',
    'strafeR': 'strafe_b.fbx',
    'fire':    'firing.fbx',
    'reload':  'reloading.fbx',
    'hit':     'hit.fbx',
    'death':   'death.fbx',
}

BONE_RE = re.compile(r'pose\.bones\["([^"]+)"\]')


def norm(name):
    return re.sub(r'[^a-z0-9]', '', name.lower())


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def armatures():
    return [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']


def remove_except(keep):
    keep_set = {keep} | set(keep.children_recursive)
    for obj in [o for o in bpy.context.scene.objects
                if o not in keep_set and o.type in ('ARMATURE', 'MESH')]:
        try:
            bpy.data.objects.remove(obj, do_unlink=True)
        except Exception:
            pass


def retarget_action(action, bone_lookup):
    """Rewrite fcurve bone references onto the body armature's bone names."""
    missing = set()
    for fc in action.fcurves:
        m = BONE_RE.search(fc.data_path)
        if not m:
            continue
        src = m.group(1)
        dst = bone_lookup.get(norm(src))
        if dst is None:
            missing.add(src)
        elif dst != src:
            fc.data_path = fc.data_path.replace(f'"{src}"', f'"{dst}"')
    return missing


def push_to_nla(arm, action, name):
    action.name = name
    action.use_fake_user = True
    if not arm.animation_data:
        arm.animation_data_create()
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, int(action.frame_range[0]), action)
    arm.animation_data.action = None


def main(body_glb, anim_dir, out_glb):
    clear_scene()

    print(f"Body: {body_glb}")
    bpy.ops.import_scene.gltf(filepath=body_glb)
    arms = armatures()
    if not arms:
        print("ERROR — no armature in body GLB")
        return 1
    body = arms[0]
    if body.animation_data:
        body.animation_data.action = None
        for t in list(body.animation_data.nla_tracks):
            body.animation_data.nla_tracks.remove(t)

    bone_lookup = {norm(b.name): b.name for b in body.data.bones}
    print(f"Body armature '{body.name}' — {len(bone_lookup)} bones")

    added = 0
    for clip, fname in ANIMS.items():
        path = os.path.join(anim_dir, fname)
        if not os.path.exists(path):
            print(f"  WARNING — missing {fname}, skipping '{clip}'")
            continue
        bpy.ops.import_scene.fbx(filepath=path, use_anim=True,
                                 automatic_bone_orientation=False)
        temp = [a for a in armatures() if a != body]
        if not temp:
            print(f"  WARNING — no armature in {fname}")
            continue
        tmp = temp[0]
        action = tmp.animation_data.action if tmp.animation_data else None
        if not action:
            print(f"  WARNING — no action in {fname}")
            remove_except(body)
            continue

        missing = retarget_action(action, bone_lookup)
        frames = int(action.frame_range[1] - action.frame_range[0])
        push_to_nla(body, action, clip)
        added += 1
        note = f"  ({len(missing)} unmatched bones)" if missing else ""
        print(f"  ok  {clip:8} <- {fname:18} {frames:3} frames{note}")
        if missing:
            print(f"      e.g. {sorted(missing)[:3]}")
        remove_except(body)

    print(f"Grafted {added}/{len(ANIMS)} clips")
    bpy.ops.export_scene.gltf(
        filepath=out_glb, export_format='GLB',
        export_animations=True, export_nla_strips=True, export_skins=True,
        export_image_format='WEBP', export_image_quality=80,
    )
    if os.path.exists(out_glb):
        print(f"OK  {out_glb}  ({os.path.getsize(out_glb)/1024:.0f} KB)")
        return 0
    print("ERROR — export produced no file")
    return 1


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(argv) < 3:
        print(__doc__)
        sys.exit(1)
    sys.exit(main(os.path.abspath(argv[0]), os.path.abspath(argv[1]), os.path.abspath(argv[2])))
