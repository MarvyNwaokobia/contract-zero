"""
Valor - render a quick preview thumbnail of each FBX so a human (or Claude) can
see what a character actually looks like instead of guessing from its filename.

Mixamo downloads are named after whatever you typed in the search box, which is
routinely not what the character is. This renders each one front-on so they can
be matched to classes by eye.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/preview_fbx.py -- \
      apps/web/public/characters/raw design/captures/characters "File A.fbx" "File B.fbx"

Omit the trailing filenames to preview every .fbx directly inside the source dir.
"""

import bpy
import os
import sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
src_dir, out_dir = argv[0], argv[1]
only = argv[2:]

os.makedirs(out_dir, exist_ok=True)

names = only if only else sorted(
    f for f in os.listdir(src_dir) if f.lower().endswith(('.fbx', '.glb', '.gltf'))
)


def import_any(path):
    """FBX for Mixamo downloads, glTF for our converted output."""
    if path.lower().endswith(('.glb', '.gltf')):
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        bpy.ops.import_scene.fbx(filepath=path)


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for item in list(block):
            try:
                block.remove(item)
            except RuntimeError:
                pass


def mesh_bounds():
    """World-space bounding box over every mesh in the scene."""
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    found = False
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        found = True
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], world[i])
                hi[i] = max(hi[i], world[i])
    return (lo, hi) if found else (None, None)


for name in names:
    path = os.path.join(src_dir, name)
    if not os.path.exists(path):
        print(f'MISSING {name}')
        continue

    clear_scene()
    try:
        import_any(path)
    except Exception as exc:  # noqa: BLE001 - report and carry on to the next file
        print(f'FAILED  {name}: {exc}')
        continue

    meshes = [o.name for o in bpy.context.scene.objects if o.type == 'MESH']
    mats = sorted({m.name for m in bpy.data.materials})
    imgs = sorted({i.name for i in bpy.data.images if i.name != 'Render Result'})
    # Animations matter as much as the mesh here: a GLB that converted its body
    # but dropped its NLA strips looks fine in a still and is useless in game.
    clips = sorted({a.name for a in bpy.data.actions})
    print(f'--- {name}')
    print(f'    meshes: {meshes[:6]}')
    print(f'    materials: {mats[:8]}')
    print(f'    textures: {len(imgs)} -> {imgs[:6]}')
    print(f'    CLIPS: {clips}')

    lo, hi = mesh_bounds()
    if lo is None:
        print('    no mesh, skipping render')
        continue

    centre = (lo + hi) * 0.5
    height = max(hi.z - lo.z, 0.001)
    width = max(hi.x - lo.x, 0.001)

    # Front-on orthographic camera on -Y, framed to the character's height.
    cam_data = bpy.data.cameras.new('cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(height, width) * 1.15
    cam = bpy.data.objects.new('cam', cam_data)
    cam.location = (centre.x, lo.y - max(height, width) * 3, centre.z)
    cam.rotation_euler = (1.5708, 0, 0)   # look along +Y
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    # Workbench renders fast and shows the diffuse textures, which is all that is
    # needed to tell a soldier from a barbarian.
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'TEXTURE'
    scene.render.film_transparent = False
    scene.render.resolution_x = 512
    scene.render.resolution_y = 640
    scene.render.filepath = os.path.join(
        out_dir, os.path.splitext(name)[0].replace(' ', '_') + '.png'
    )
    bpy.ops.render.render(write_still=True)
    print(f'    -> {scene.render.filepath}')

print('done')
