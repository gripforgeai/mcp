"""GripForge read-only UE -> portable scene worker (Python commandlet).

Run in a separate editor process with rendering enabled and -GFExportJob=<dir>.
No source asset/map is saved. Atomic checkpoints survive the MCP request.
"""
import hashlib
import json
import math
import os
import re
import time
import traceback
from pathlib import Path
import unreal

match = re.search(r'-GFExportJob=(?:"([^"]+)"|(\S+))', unreal.SystemLibrary.get_command_line())
if not match:
    raise RuntimeError('Missing -GFExportJob')
folder = Path(match.group(1) or match.group(2)).resolve()
request = json.loads((folder / 'request.json').read_text())
fingerprint = hashlib.sha256((folder / 'request.json').read_bytes()).hexdigest()
manifest_path = folder / 'native.json'
state_path = folder / 'status.json'


def atomic(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, separators=(',', ':')))
    tmp.replace(path)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def cancelled():
    p = folder / 'control.json'
    if p.exists() and json.loads(p.read_text()).get('cancel'):
        raise InterruptedError('Export cancelled; completed assets retained')


def progress(stage, **kw):
    cancelled()
    atomic(state_path, dict(schema='gripforge.unreal-export-job.v1', request_hash=fingerprint,
                            status='running', stage=stage, pid=os.getpid(), updated_at=time.time(), **kw))


def xyz(v):
    return [float(v.x), float(v.y), float(v.z)]


def transform(t):
    q = t.rotation
    p, s = t.translation, t.scale3d
    return dict(translation=dict(x=p.x*.01, y=p.z*.01, z=p.y*.01),
                rotation=dict(x=-q.x, y=-q.z, z=-q.y, w=q.w),
                scale=dict(x=s.x, y=s.z, z=s.y))


def native_prop(obj, names, default=None):
    for name in names:
        try:
            return obj.get_editor_property(name)
        except Exception:
            pass
    return default


def file_record(file):
    p = folder / file
    return dict(file=file, sha256=sha(p), bytes=p.stat().st_size)


def done(record):
    p = folder / record['file']
    return p.is_file() and sha(p) == record['sha256']


def package_file(path):
    package = path.split('.')[0]
    if package.startswith('/Game/'):
        return Path(unreal.Paths.project_content_dir()) / (package[6:] + '.uasset')
    if package.startswith('/Engine/'):
        return Path(unreal.Paths.engine_content_dir()) / (package[8:] + '.uasset')
    return None


def png(rt, name):
    unreal.RenderingLibrary.export_render_target(world, rt, str(folder), name)
    path = folder / name
    if not path.is_file() or path.stat().st_size < 64:
        raise RuntimeError('Render target export failed: ' + name)
    return file_record(name)


try:
    assert request['schema'] == 'gripforge.unreal-export-request.v1'
    assert Path(unreal.Paths.get_project_file_path()).resolve() == Path(request['project_file']).resolve()
    source_file = Path(request['project_file']).parent / 'Content' / (request['source_level'][6:] + '.umap')
    assert sha(source_file) == request['source_sha256'], 'Source level changed; prepare a new job'
    progress('loading_source')
    world = unreal.EditorLoadingAndSavingUtils.load_map(request['source_level'])
    assert world and world.get_path_name().split('.')[0] == request['source_level']
    actors = unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor)
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if previous:
        assert previous['request_hash'] == fingerprint, 'Job inputs changed'
    manifest = dict(schema='gripforge.unreal-export.v1', request_hash=fingerprint,
                    source_level=request['source_level'], source_sha256=request['source_sha256'],
                    project=Path(request['project_file']).stem, units='metres', up='Y',
                    assets=previous.get('assets', {}), instances=[], terrains=previous.get('terrains', []),
                    environment={}, lights=[], cameras=[], omitted={}, warnings=[])
    definitions, landscapes, dependencies = {}, [], {}

    def omit(kind):
        manifest['omitted'][kind] = manifest['omitted'].get(kind, 0) + 1

    def pin(path):
        p = package_file(path)
        if p and p.is_file():
            info = p.stat()
            dependencies[str(p)] = [info.st_size, info.st_mtime_ns]

    pinned_materials = set()
    def pin_material(material):
        if not material or material.get_path_name() in pinned_materials:
            return
        pinned_materials.add(material.get_path_name())
        pin(material.get_path_name())
        if isinstance(material, unreal.Material):
            for tex in unreal.MaterialEditingLibrary.get_used_textures(material):
                pin(tex.get_path_name())
        else:
            for value in native_prop(material, ['texture_parameter_values'], []):
                tex = value.get_editor_property('parameter_value')
                if tex:
                    pin(tex.get_path_name())
            pin_material(native_prop(material, ['parent']))

    for actor in actors:
        cancelled()
        cls = actor.get_class().get_path_name()
        if isinstance(actor, unreal.LandscapeProxy):
            landscapes.append(actor)
            continue
        if isinstance(actor, unreal.DirectionalLight):
            comp = actor.get_component_by_class(unreal.DirectionalLightComponent)
            direction = actor.get_actor_forward_vector()
            color = comp.get_light_color()
            manifest['environment'] = dict(sun=[-direction.x, -direction.z, -direction.y],
                                            color=[color.r, color.g, color.b], intensity=comp.get_editor_property('intensity'))
            continue
        if isinstance(actor, unreal.CameraActor):
            c = actor.get_camera_component()
            p, d = actor.get_actor_location(), actor.get_actor_forward_vector()
            manifest['cameras'].append(dict(name=actor.get_actor_label(), position=[p.x*.01,p.z*.01,p.y*.01],
                                             target=[(p.x+d.x*1000)*.01,(p.z+d.z*1000)*.01,(p.y+d.y*1000)*.01], fov=c.field_of_view))
        # Procedural UE skies and water are reported, not exported as opaque domes/planes.
        if re.search(r'(?:GoodSky|UltraDynamicSky|SkySphere|SkyAtmosphere|CartoonWater)', cls, re.I):
            omit(cls)
            continue
        components = actor.get_components_by_class(unreal.StaticMeshComponent)
        supported = 0
        for component in components:
            mesh = component.static_mesh
            if not mesh or not component.is_visible():
                continue
            if isinstance(component, unreal.SplineMeshComponent):
                omit('SplineMeshComponent (deformed mesh requires a dedicated bake)')
                continue
            materials = [component.get_material(i) for i in range(component.get_num_materials())]
            paths = [m.get_path_name() if m else None for m in materials]
            source = dict(mesh=mesh.get_path_name(), materials=paths)
            key = hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest()[:24]
            definitions[key] = (mesh, materials, source)
            pin(mesh.get_path_name())
            for material in materials:
                pin_material(material)
            transforms = []
            if isinstance(component, unreal.InstancedStaticMeshComponent):
                transforms = [component.get_instance_transform(i, world_space=True) for i in range(component.get_instance_count())]
            else:
                transforms = [component.get_world_transform()]
            for i, t in enumerate(transforms):
                identifier = component.get_path_name() + ':' + str(i)
                manifest['instances'].append(dict(id='ue_'+hashlib.sha256(identifier.encode()).hexdigest()[:24],
                    name=actor.get_actor_label()[:145], source=identifier, asset=key, transform=transform(t),
                    batch=isinstance(component, unreal.InstancedStaticMeshComponent)))
            supported += len(transforms)
        if not supported and not components and any(s in cls for s in ['Niagara', 'Decal', 'SpotLight', 'RectLight', 'PointLight']):
            omit(cls)
    manifest['source_snapshot'] = dependencies
    if previous.get('source_snapshot') and previous['source_snapshot'] != dependencies:
        raise RuntimeError('Source dependencies changed; use a new export job')
    atomic(manifest_path, manifest)
    assert len(manifest['instances']) <= 100000, 'Map exceeds 100,000 portable instances; export regions'
    progress('inventory', instances=len(manifest['instances']), unique_assets=len(definitions), landscapes=len(landscapes))

    # UE finishes compiling before render-target capture/material baking.
    # Commandlets do not tick the editor to apply asynchronous shader results.
    # Preload the export shader as well, before the native blocking compile command.
    unreal.load_asset('/Engine/EditorLandscapeResources/Landscape_Heightmap_To_RenderTarget2D')
    unreal.load_asset('/Engine/EditorLandscapeResources/Landscape_Weightmap_To_RenderTarget2D')
    unreal.SystemLibrary.execute_console_command(world, 'Editor.AsyncAssetCompilationFinishAll')
    for landscape in landscapes:
        cancelled()
        key = landscape.get_name()
        old = next((t for t in manifest['terrains'] if t['id'] == key), None)
        if old and old.get('bake_version') == 2 and all(done(old[k]) for k in ['heightmap', 'albedo']):
            continue
        progress('terrain', terrain=key)
        rotation = landscape.get_actor_rotation()
        assert abs(rotation.pitch)+abs(rotation.yaw)+abs(rotation.roll) < .001, 'Rotated Landscape needs a dedicated adapter'
        components = landscape.get_components_by_class(unreal.LandscapeComponent)
        bases = [(int(c.get_editor_property('section_base_x')), int(c.get_editor_property('section_base_y'))) for c in components]
        q = native_prop(components[0], ['ComponentSizeQuads', 'component_size_quads'])
        if not q:
            diffs = [abs(b-a) for axis in [0,1] for a,b in zip(sorted(set(p[axis] for p in bases)), sorted(set(p[axis] for p in bases))[1:])]
            assert diffs, 'Cannot determine single-component Landscape resolution'
            q = math.gcd(*diffs)
        minx, miny = min(p[0] for p in bases), min(p[1] for p in bases)
        maxx, maxy = max(p[0] for p in bases)+q, max(p[1] for p in bases)+q
        width, height = maxx-minx+1, maxy-miny+1
        assert max(width,height) <= 8192, 'Landscape exceeds 8192 height samples; export regions'
        rt = unreal.RenderingLibrary.create_render_target2d(world, width, height, unreal.TextureRenderTargetFormat.RTF_RGBA8)
        assert landscape.landscape_export_heightmap_to_render_target(rt, True, False)
        heightmap = png(rt, key+'-height-rg.png')
        unreal.RenderingLibrary.release_render_target2d(rt)
        visibility = None
        layer_names = [str(n) for n in landscape.get_target_layer_names(True)] if hasattr(landscape, 'get_target_layer_names') else []
        visibility_name = next((n for n in layer_names if 'visibility' in n.lower()), None)
        if visibility_name:
            rt = unreal.RenderingLibrary.create_render_target2d(world, width, height, unreal.TextureRenderTargetFormat.RTF_RGBA8)
            assert landscape.landscape_export_weightmap_to_render_target(rt, visibility_name), 'Visibility mask export failed'
            visibility = png(rt, key+'-visibility.png')
            unreal.RenderingLibrary.release_render_target2d(rt)
        p, s = landscape.get_actor_location(), landscape.get_actor_scale3d()
        assert s.x > 0 and s.y > 0 and s.z > 0, 'Reflected Landscape requires a dedicated adapter'
        center = unreal.Vector(p.x+(minx+maxx)*s.x/2, p.y+(miny+maxy)*s.y/2, p.z+200000)
        capture = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.SceneCapture2D, center, unreal.Rotator(-90,-90,0))
        comp = capture.get_component_by_class(unreal.SceneCaptureComponent2D)
        size = request.get('terrain_texture_size', 4096)
        rt = unreal.RenderingLibrary.create_render_target2d(world, size, size, unreal.TextureRenderTargetFormat.RTF_RGBA8)
        comp.set_editor_property('texture_target', rt)
        comp.set_editor_property('projection_type', unreal.CameraProjectionMode.ORTHOGRAPHIC)
        # Export a square orthographic projection; the manifest retains the crop.
        span = max((maxx-minx)*s.x, (maxy-miny)*s.y)
        comp.set_editor_property('ortho_width', span)
        comp.set_editor_property('capture_source', unreal.SceneCaptureSource.SCS_BASE_COLOR)
        comp.set_editor_property('primitive_render_mode', unreal.SceneCapturePrimitiveRenderMode.PRM_USE_SHOW_ONLY_LIST)
        comp.show_only_actor_components(landscape)
        comp.set_editor_property('capture_every_frame', False)
        comp.set_editor_property('capture_on_movement', False)
        comp.capture_scene()
        albedo = png(rt, key+'-albedo.png')
        unreal.get_editor_subsystem(unreal.EditorActorSubsystem).destroy_actor(capture)
        unreal.RenderingLibrary.release_render_target2d(rt)
        row = dict(id=key, bake_version=2, heightmap=heightmap, albedo=albedo, width=width, height=height,
                   base=[minx,miny], components=bases, component_quads=q, origin=xyz(p), scale=xyz(s),
                   albedo_span_cm=span, material=landscape.get_editor_property('landscape_material').get_path_name())
        if visibility:
            row['visibility'] = visibility
        manifest['terrains'] = [t for t in manifest['terrains'] if t['id'] != key]+[row]
        atomic(manifest_path, manifest)

    options = unreal.GLTFExportOptions()
    options.set_editor_property('export_uniform_scale', .01)
    options.set_editor_property('bake_material_inputs', unreal.GLTFMaterialBakeMode.USE_MESH_DATA)
    options.set_editor_property('default_material_bake_size', unreal.GLTFMaterialBakeSize(request.get('texture_size',1024), request.get('texture_size',1024)))
    options.set_editor_property('texture_image_format', unreal.GLTFTextureImageFormat.PNG)
    options.set_editor_property('adjust_normalmaps', True)
    options.set_editor_property('export_vertex_colors', False)
    options.set_editor_property('export_lights', False)
    options.set_editor_property('export_cameras', False)
    options.set_editor_property('export_level_sequences', False)
    (folder/'assets').mkdir(exist_ok=True)
    for index, (key, (mesh, materials, source)) in enumerate(definitions.items()):
        progress('meshes', completed=index, total=len(definitions), asset=mesh.get_name())
        old = manifest['assets'].get(key)
        if old and done(old):
            continue
        # Export one neutral instance of each mesh/material combination. No mutation of Library/native assets.
        temp = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(0,0,0))
        comp = temp.static_mesh_component
        comp.set_static_mesh(mesh)
        for slot, material in enumerate(materials):
            if material:
                comp.set_material(slot, material)
        name = 'assets/'+key+'.glb'
        try:
            unreal.GLTFExporter.export_to_gltf(world, str(folder/name), options, {temp})
            assert (folder/name).is_file(), 'GLB export failed: '+source['mesh']
            manifest['assets'][key] = dict(file_record(name), name=mesh.get_name(), source=source)
            atomic(manifest_path, manifest)
        finally:
            unreal.get_editor_subsystem(unreal.EditorActorSubsystem).destroy_actor(temp)
    if manifest['terrains']:
        progress('native_reference')
        terrain = manifest['terrains'][0]
        o, s, base = terrain['origin'], terrain['scale'], terrain['base']
        sx, sy = (terrain['width']-1)*s[0], (terrain['height']-1)*s[1]
        span = max(sx, sy)
        target = unreal.Vector(o[0]+(base[0]+(terrain['width']-1)/2)*s[0], o[1]+(base[1]+(terrain['height']-1)/2)*s[1], o[2])
        position = target + unreal.Vector(span*.55, span*.65, span*.7)
        capture = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(unreal.SceneCapture2D, position, unreal.MathLibrary.find_look_at_rotation(position,target))
        try:
            comp = capture.get_component_by_class(unreal.SceneCaptureComponent2D)
            rt = unreal.RenderingLibrary.create_render_target2d(world, 1600, 900, unreal.TextureRenderTargetFormat.RTF_RGBA8)
            comp.set_editor_property('texture_target', rt)
            comp.set_editor_property('fov_angle', math.degrees(2*math.atan(math.tan(math.radians(55)/2)*1600/900)))
            comp.set_editor_property('capture_source', unreal.SceneCaptureSource.SCS_FINAL_COLOR_LDR)
            comp.set_editor_property('capture_every_frame', False)
            comp.set_editor_property('capture_on_movement', False)
            unreal.SystemLibrary.execute_console_command(world, 'Editor.AsyncAssetCompilationFinishAll')
            comp.capture_scene()
            manifest['native_reference'] = png(rt, 'unreal-overview.png')
            unreal.RenderingLibrary.release_render_target2d(rt)
        finally:
            unreal.get_editor_subsystem(unreal.EditorActorSubsystem).destroy_actor(capture)
    for file, before in dependencies.items():
        info = Path(file).stat()
        assert [info.st_size,info.st_mtime_ns] == before, 'Source changed during export: '+file
    assert sha(source_file) == request['source_sha256'], 'Source level changed during export'
    manifest['warnings'] = [
        'Native Blueprint logic, Niagara, decals, animated water and procedural sky are not portable; omitted classes are counted.',
        'Complex static materials are baked. Time/view/world-dependent shader behavior is not retained.',
        'Landscape base color is a top-down native bake; material paint layers remain a source provenance, not an editable UE shader graph.',
    ]
    manifest['status'] = 'exported-awaiting-gripforge-review'
    atomic(manifest_path,manifest)
    atomic(state_path,dict(status='succeeded',stage='exported',request_hash=fingerprint,updated_at=time.time(),
                          instances=len(manifest['instances']),assets=len(manifest['assets']),terrains=len(manifest['terrains']),lifecycle='work'))
except Exception as error:
    atomic(state_path, dict(status='cancelled' if isinstance(error,InterruptedError) else 'failed',
                           error=str(error), traceback=traceback.format_exc(), request_hash=fingerprint,updated_at=time.time()))
    unreal.log_error(traceback.format_exc())
    raise
