"""Blender manufacture worker. No source scripts, handlers or .blend files are loaded."""
import bpy
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text())
source, output = plan['input'], plan['output']
kind = Path(source).suffix.lower()
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
if kind in ('.dds', '.tga'):
    image = bpy.data.images.load(source, check_existing=False)
    if not len(image.pixels):
        raise ValueError('Image decoder returned no pixels')
    image.pack()  # Resolve lazy pixels before changing the source filepath.
    if not image.has_data:
        raise ValueError('Image decoder returned no pixels')
    image.filepath_raw = output
    image.file_format = 'PNG'
    image.save()
else:
    if kind == '.fbx':
        bpy.ops.import_scene.fbx(filepath=source, use_image_search=False)
    elif kind == '.obj':
        bpy.ops.wm.obj_import(filepath=source)
    else:
        raise ValueError('Unsupported source format')
    if not any(o.type == 'MESH' for o in bpy.context.scene.objects):
        raise ValueError('No mesh imported')
    # Pack only staged images. Missing textures remain an explicit conversion failure.
    stage = Path(source).parent.resolve()
    for image in bpy.data.images:
        if image.source == 'FILE' and not image.packed_file:
            path = Path(bpy.path.abspath(image.filepath)).resolve()
            if not path.is_relative_to(stage) or not path.is_file():
                raise ValueError('Missing or external material texture: ' + image.name)
            image.pack()
    bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', export_animations=True)
Path(plan['receipt']).write_text(json.dumps({'version': bpy.app.version_string}))
