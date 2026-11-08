"""
Valor — FBX to GLB batch converter

Run with Intel (x86_64) Blender on Intel Macs:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/fbx_to_glb.py -- apps/web/public/characters/raw apps/web/public/characters/glb

Download Intel Blender: https://www.blender.org/download/  → macOS Intel 64 bit
"""

import bpy
import os
import sys

# Explicit mapping of actual Mixamo download filenames to our animation names.
# character: the FBX with mesh + skeleton ("With Skin" download from Mixamo)
# animations: {our_animation_name: actual_filename}
# The three player classes now share one animation set, and it is a RIFLE set:
# rifle idle, gunplay shooting, hit reaction, forward death. They used to carry
# melee clips (barbarian idle, sword attacks) from the pre-TTK arena game, which
# would have left the new tactical bodies punching each other in duels.
#
# Filenames are normalised by the staging step rather than using the raw Mixamo
# download names, which are whatever was typed into the search box and routinely
# describe the wrong character. What each source actually was:
#   berserker <- Mixamo "Soldier"      (helmet, plate carrier, holstered sidearm)
#   sentinel  <- Mixamo "Ch35"         (gas mask, heavy riot vest) - the tank read
#   phantom   <- Mixamo "SpacePirate"  (lean, sleek) - the fast flanker read
CLASS_FILES = {
    'berserker': {
        'character': 'character.fbx',
        'animations': {
            'idle':   'idle.fbx',
            'attack': 'attack.fbx',
            'hit':    'hit.fbx',
            'death':  'death.fbx',
        },
    },
    'sentinel': {
        'character': 'character.fbx',
        'animations': {
            'idle':   'idle.fbx',
            'attack': 'attack.fbx',
            'hit':    'hit.fbx',
            'death':  'death.fbx',
        },
    },
    'phantom': {
        'character': 'character.fbx',
        'animations': {
            'idle':   'idle.fbx',
            'attack': 'attack.fbx',
            'hit':    'hit.fbx',
            'death':  'death.fbx',
        },
    },
    # Valor doorkicker enemy (the plan slice 7b). Mixamo X Bot + the Slim Shooter
    # Pack rifle set. Clip names map 1:1 onto FpsSim's enemy AI states.
    'operator': {
        'character': 'xbot.fbx',
        'animations': {
            'idle':    'aim_idle.fbx',   # rifle shouldered — the 'aim' telegraph
            'walk':    'walking.fbx',
            'run':     'rifle_run.fbx',
            'strafeL': 'strafe_a.fbx',
            'strafeR': 'strafe_b.fbx',
            'fire':    'firing.fbx',
            'reload':  'reloading.fbx',
            'hit':     'hit.fbx',
            'death':   'death.fbx',
        },
    },
}


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions,
                  bpy.data.materials, bpy.data.images, bpy.data.textures):
        for item in list(block):
            block.remove(item)


def import_fbx(filepath):
    bpy.ops.import_scene.fbx(
        filepath=filepath,
        use_anim=True,
        automatic_bone_orientation=False,
        use_image_search=True,
    )


def get_armatures():
    return [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']


def remove_except(keep_object):
    """Remove all scene armatures and meshes except keep_object and its children."""
    # keep_object (the main armature) AND all its children (the character mesh)
    keep = {keep_object} | set(keep_object.children_recursive)
    to_remove = [
        obj for obj in bpy.context.scene.objects
        if obj not in keep and obj.type in ('ARMATURE', 'MESH')
    ]
    for obj in to_remove:
        try:
            bpy.data.objects.remove(obj, do_unlink=True)
        except Exception:
            pass


def push_action_to_nla(armature, action, name):
    """Register an action as a named NLA strip on the armature."""
    action.name = name
    action.use_fake_user = True   # prevent garbage collection
    if not armature.animation_data:
        armature.animation_data_create()
    track = armature.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, int(action.frame_range[0]), action)
    armature.animation_data.action = None   # detach active so NLA takes over


def create_rest_pose_idle(armature):
    """Generate a 60-frame idle by keying the armature's current rest pose."""
    bpy.context.view_layer.objects.active = armature
    if not armature.animation_data:
        armature.animation_data_create()

    action = bpy.data.actions.new('idle')
    armature.animation_data.action = action

    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')

    for frame in (1, 60):
        bpy.context.scene.frame_set(frame)
        bpy.ops.anim.keyframe_insert_menu(type='WholeCharacterSelected')

    bpy.ops.object.mode_set(mode='OBJECT')
    print("  Created 60-frame rest-pose idle")
    return action


def process_class(class_dir, output_path, class_name):
    print(f"\n{'=' * 52}")
    print(f"  {class_name.upper()}")
    print(f"{'=' * 52}")

    cls_lower = class_name.lower()
    if cls_lower not in CLASS_FILES:
        print(f"  SKIP — no file mapping for '{class_name}'")
        return False

    cfg = CLASS_FILES[cls_lower]
    char_fbx = os.path.join(class_dir, cfg['character'])
    if not os.path.exists(char_fbx):
        print(f"  ERROR — character file not found: {cfg['character']}")
        return False

    clear_scene()

    # ── Base character (mesh + skeleton) ──────────────────────────────
    print(f"  Importing base: {cfg['character']} ...")
    import_fbx(char_fbx)

    arms = get_armatures()
    if not arms:
        print("  ERROR — no armature in character file")
        return False

    main_arm = arms[0]
    print(f"  Armature: {main_arm.name}")
    if not main_arm.animation_data:
        main_arm.animation_data_create()
    # Clear any animation baked into the T-Pose file — we want clean NLA only
    main_arm.animation_data.action = None

    # ── Animations ────────────────────────────────────────────────────
    idle_added = False
    for anim_name, anim_file in cfg['animations'].items():
        anim_path = os.path.join(class_dir, anim_file)
        if not os.path.exists(anim_path):
            print(f"  WARNING — '{anim_file}' not found, skipping '{anim_name}'")
            continue

        print(f"  Importing: {anim_file} → '{anim_name}' ...")
        import_fbx(anim_path)

        new_arms = [a for a in get_armatures() if a != main_arm]
        if not new_arms:
            print(f"    WARNING — no armature in {anim_file}")
            remove_except(main_arm)
            continue

        tmp_arm = new_arms[0]
        action = None
        if tmp_arm.animation_data:
            action = tmp_arm.animation_data.action

        if action:
            push_action_to_nla(main_arm, action, anim_name)
            frames = int(action.frame_range[1] - action.frame_range[0])
            print(f"    ✓ '{anim_name}' — {frames} frames")
            if anim_name == 'idle':
                idle_added = True
        else:
            print(f"    WARNING — no action found in {anim_file}")

        remove_except(main_arm)

    # Fallback: generate rest-pose idle if none was found
    if not idle_added:
        print("  No idle animation — generating rest-pose idle ...")
        try:
            action = create_rest_pose_idle(main_arm)
            push_action_to_nla(main_arm, action, 'idle')
        except Exception as e:
            print(f"  WARNING — could not generate idle: {e}")

    # ── Resize textures > 1024px before export to keep file sizes web-safe ──
    for img in bpy.data.images:
        if img.size[0] > 1024 or img.size[1] > 1024:
            scale = 1024 / max(img.size[0], img.size[1])
            new_w = max(1, int(img.size[0] * scale))
            new_h = max(1, int(img.size[1] * scale))
            img.scale(new_w, new_h)
            print(f"  Resized texture '{img.name}' → {new_w}×{new_h}")

    # ── Export GLB ─────────────────────────────────────────────────────
    print("  Exporting GLB ...")
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        export_animations=True,
        export_nla_strips=True,
        export_skins=True,
        export_apply=False,
        export_image_format='WEBP',
        export_image_quality=80,
    )

    if os.path.exists(output_path):
        size_kb = os.path.getsize(output_path) / 1024
        print(f"  ✓ {output_path}  ({size_kb:.0f} KB)")
        return True

    print("  ERROR — output file not created")
    return False


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)

    raw_dir = os.path.abspath(argv[0])
    glb_dir = os.path.abspath(argv[1])
    print(f"Raw dir: {raw_dir}")
    print(f"GLB dir: {glb_dir}")
    os.makedirs(glb_dir, exist_ok=True)

    ok = fail = 0
    for cls in sorted(os.listdir(raw_dir)):
        cls_path = os.path.join(raw_dir, cls)
        if not os.path.isdir(cls_path):
            continue
        out_path = os.path.join(glb_dir, f"{cls}.glb")
        if process_class(cls_path, out_path, cls):
            ok += 1
        else:
            fail += 1

    print(f"\n{'=' * 52}")
    print(f"  Done — {ok} converted, {fail} failed")
    print(f"{'=' * 52}")
