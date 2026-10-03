"""GripForge native map adapter, UE 5.7. Recipe-independent; consumes plan.json only.

Run in the full editor with -ExecutePythonScript=<this file> -GFMapPlan=<plan.json>.
The common scene, bindings and completed work stay on disk. Never saves native source packages.
"""
import hashlib
import json
import math
import os
import re
import sys
import time
import traceback
from pathlib import Path
import unreal

sys.path.insert(0, str(Path(__file__).parent))
from unreal_scene_math import world_matrices, native_transform, point, identity, exposure_brightness
from unreal_spawn_review import SpawnReview

unreal.EditorPythonScripting.set_keep_python_script_alive(True)
match = re.search(r'-GFMapPlan=(?:"([^"]+)"|(\S+))', unreal.SystemLibrary.get_command_line())
if not match:
    raise RuntimeError('Missing -GFMapPlan')
plan_file = Path(match.group(1) or match.group(2)).resolve()
job_dir = plan_file.parent
plan_bytes = plan_file.read_bytes()
plan = json.loads(plan_bytes)
plan_hash = hashlib.sha256(plan_bytes).hexdigest()
status_file = job_dir / 'status.json'
state = json.loads(status_file.read_text()) if status_file.exists() else {}
if state.get('plan_hash') not in (None, plan_hash):
    raise RuntimeError('Immutable job plan changed. Prepare a new work revision.')
state.update(plan_hash=plan_hash, lifecycle='work', target_level=plan['target_level'], pid=os.getpid())
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
assets = unreal.EditorAssetLibrary
folder = plan['asset_folder']
existing, sources, materials, world = {}, {}, {}, None
nodes = {n['id']: n for n in plan['document']['nodes']}
matrices = world_matrices(list(nodes.values()))


def progress(stage, **values):
    state.update(stage=stage, updated_at=time.time(), **values)
    temp = status_file.with_suffix('.tmp')
    temp.write_text(json.dumps(state, indent=2))
    temp.replace(status_file)
    unreal.log('GRIPFORGE_MAP ' + stage)


def save():
    if world and not levels.save_current_level():
        raise RuntimeError('Cannot save the work level.')


def cancelled():
    file = job_dir / 'control.json'
    if file.exists() and json.loads(file.read_text()).get('cancel'):
        # Geometry was checkpointed before the PIE review; never save a play world.
        if not levels.is_in_play_in_editor():
            save()
        raise InterruptedError('Cancelled at a saved checkpoint. Relaunch the same job to resume.')


def vec(p):
    return unreal.Vector(p['x'] * 100, p['z'] * 100, p['y'] * 100)


def rgb(value, gain=1):
    # Scene hex colours are sRGB, Unreal's LinearColor is linear.
    values = [int(value[i:i+2], 16)/255 for i in (1, 3, 5)]
    return unreal.LinearColor(*[(v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4)*gain for v in values], 1)


def apply_transform(actor, matrix, source=None):
    translation, rotation, scale = native_transform(matrix, source)
    actor.set_actor_transform(unreal.Transform(location=unreal.Vector(*translation), rotation=unreal.Quat(*rotation).rotator(), scale=unreal.Vector(*scale)), False, True)


def new_actor(kind, key, name, group):
    if key in existing:
        return existing[key]
    actor = actors.spawn_actor_from_class(kind, unreal.Vector())
    if not actor:
        raise RuntimeError('Cannot spawn ' + key)
    actor.set_actor_label(name)
    actor.set_folder_path('GripForge/' + group)
    if kind == unreal.TargetPoint:
        actor.root_component.set_mobility(unreal.ComponentMobility.STATIC)
    actor.tags = ['GripForge.Scene', 'gf:' + key, 'gf:job:' + plan_hash]
    existing[key] = actor
    return actor


def finished(actor):
    return 'gf:complete' in [str(t) for t in actor.tags]


def finish(actor, node=None):
    tags = [str(t) for t in actor.tags if str(t) != 'gf:complete' and not str(t).startswith('gf:data:')]
    if node:
        # Carry the portable data with the editable native actor, including polygons, roles and seeds.
        payload = {k:v for k,v in node.items() if k not in ('heights', 'splat')}
        tags.append('gf:data:' + json.dumps(payload, separators=(',', ':')))
        actor.set_actor_hidden_in_game(not node['visible'] or node['type'] in ('group','path','region','zone'))
        actor.set_is_temporarily_hidden_in_editor(not node['visible'])
    actor.tags = tags + ['gf:complete']


def owned_asset(path):
    if not assets.does_asset_exist(path):
        return None
    asset = unreal.load_asset(path)
    if assets.get_metadata_tag(asset, 'GripForgeJob') != plan_hash:
        raise RuntimeError('Existing output asset is not owned by this job: ' + path)
    return asset


def save_asset(asset):
    assets.set_metadata_tag(asset, 'GripForgeJob', plan_hash)
    if not assets.save_loaded_asset(asset):
        raise RuntimeError('Cannot save generated asset ' + asset.get_path_name())


def material_texture(source, channel, normal_format):
    if isinstance(source, str):
        texture = unreal.load_asset(source)
        if not isinstance(texture, unreal.Texture):
            raise RuntimeError('Missing PBR texture: ' + source)
        return texture
    # Never alter source texture packages. Each interpretation is an owned imported asset:
    # the same bytes can be sampled as sRGB color and as a linear mask independently.
    interpretation = 'normal_' + normal_format if channel == 'normal' else 'srgb' if channel in ('color', 'emissive') else 'linear'
    name = 'T_' + source['sha256'][:32] + '_' + interpretation
    dest = folder + '/' + name
    existing_texture = owned_asset(dest)
    if existing_texture:
        return existing_texture
    task = unreal.AssetImportTask()
    task.filename = source['file']
    task.destination_path = folder
    task.destination_name = name
    task.automated = True
    task.replace_existing = False
    task.save = False
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    texture = unreal.load_asset(dest)
    if not isinstance(texture, unreal.Texture2D):
        raise RuntimeError('Cannot import portable texture: ' + source['assetId'])
    texture.set_editor_property('srgb', channel in ('color', 'emissive'))
    texture.set_editor_property('compression_settings', unreal.TextureCompressionSettings.TC_NORMALMAP if channel == 'normal' else unreal.TextureCompressionSettings.TC_DEFAULT if channel in ('color', 'emissive') else unreal.TextureCompressionSettings.TC_MASKS)
    if channel == 'normal':
        texture.set_editor_property('flip_green_channel', normal_format == 'opengl')
    save_asset(texture)
    return texture


def material(definition):
    key = definition['id']
    if key in materials:
        return materials[key]
    dest = folder + '/M_' + key
    existing_material = owned_asset(dest)
    mat = existing_material or unreal.AssetToolsHelpers.get_asset_tools().create_asset('M_'+key, folder, unreal.Material, unreal.MaterialFactoryNew())
    edit = unreal.MaterialEditingLibrary
    if existing_material:
        edit.delete_all_material_expressions(mat)
    def connect(expression, output, prop):
        if prop==unreal.MaterialProperty.MP_BASE_COLOR and definition.get('vertex_colors'):
            vertex=edit.create_material_expression(mat,unreal.MaterialExpressionVertexColor,-100,-180)
            product=edit.create_material_expression(mat,unreal.MaterialExpressionMultiply,50,-100)
            edit.connect_material_expressions(expression,output,product,'A')
            edit.connect_material_expressions(vertex,'RGB',product,'B')
            edit.connect_material_property(product,'',prop)
        else:
            edit.connect_material_property(expression,output,prop)
    channels = [('color', unreal.MaterialProperty.MP_BASE_COLOR), ('normal', unreal.MaterialProperty.MP_NORMAL),
                ('roughness', unreal.MaterialProperty.MP_ROUGHNESS), ('metalness', unreal.MaterialProperty.MP_METALLIC),
                ('ao', unreal.MaterialProperty.MP_AMBIENT_OCCLUSION), ('emissive', unreal.MaterialProperty.MP_EMISSIVE_COLOR)]
    textures = definition.get('textures', {})
    uv = edit.create_material_expression(mat, unreal.MaterialExpressionTextureCoordinate, -650, -220)
    uv.set_editor_property('u_tiling', definition.get('repeat', [1, 1])[0])
    uv.set_editor_property('v_tiling', definition.get('repeat', [1, 1])[1])
    for index, (channel, prop) in enumerate(channels):
        if channel in textures:
            texture = material_texture(textures[channel], channel, definition.get('normal_format', 'opengl'))
            node = edit.create_material_expression(mat, unreal.MaterialExpressionTextureSample, -400, index*180)
            node.texture = texture
            edit.connect_material_expressions(uv, '', node, 'UVs')
            node.sampler_type = (unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL if channel=='normal' else
                                 unreal.MaterialSamplerType.SAMPLERTYPE_COLOR if texture.get_editor_property('srgb') else
                                 unreal.MaterialSamplerType.SAMPLERTYPE_MASKS if texture.get_editor_property('compression_settings')==unreal.TextureCompressionSettings.TC_MASKS else unreal.MaterialSamplerType.SAMPLERTYPE_LINEAR_COLOR)
            # Separate grayscale maps and glTF-style ORM images use the same channels as Three.js.
            output='RGB' if channel in ('color','normal','emissive') else ('G' if channel=='roughness' else 'B' if channel=='metalness' else 'R') if isinstance(textures[channel],dict) else 'R'
            if channel not in ('normal','ao'):
                factor=edit.create_material_expression(mat,unreal.MaterialExpressionConstant3Vector if channel in ('color','emissive') else unreal.MaterialExpressionConstant,-600,index*180+70)
                if channel in ('color','emissive'):
                    factor.constant=rgb(definition.get(channel,'#ffffff'),definition.get('emissive_intensity',1) if channel=='emissive' else 1)
                else:
                    factor.r=definition.get(channel,1)
                product=edit.create_material_expression(mat,unreal.MaterialExpressionMultiply,-150,index*180)
                edit.connect_material_expressions(node,output,product,'A')
                edit.connect_material_expressions(factor,'',product,'B')
                connect(product,'',prop)
            else:
                connect(node,output,prop)
        elif channel == 'color':
            node = edit.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, -400, index*180)
            node.constant = rgb(definition.get('color','#ffffff'))
            connect(node, '', prop)
        elif channel in ('roughness','metalness'):
            node = edit.create_material_expression(mat, unreal.MaterialExpressionConstant, -400, index*180)
            node.r = definition.get(channel, .8 if channel=='roughness' else 0)
            edit.connect_material_property(node, '', prop)
    if definition.get('emissive') and 'emissive' not in textures:
        node = edit.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, -400, 800)
        node.constant = rgb(definition['emissive'], definition.get('emissive_intensity',1))
        edit.connect_material_property(node, '', unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    if definition.get('unlit'):
        mat.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    edit.recompile_material(mat)
    save_asset(mat)
    materials[key] = mat
    return mat


def imported_mesh(source):
    name = 'SM_' + source['assetId'] + '_' + source['revisionId'][:24]
    dest = folder + '/' + name
    mesh = owned_asset(dest)
    if mesh:
        return mesh
    task = unreal.AssetImportTask()
    task.filename = source['file']
    task.destination_path = folder + '/Imported_' + source['assetId']
    task.destination_name = name
    task.automated = True
    task.replace_existing = False
    task.save = False
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    imported = [unreal.load_asset(p) for p in task.imported_object_paths]
    meshes = [asset for asset in imported if isinstance(asset, unreal.StaticMesh)]
    if len(meshes) != 1:
        raise RuntimeError('Each GLB binding must contain exactly one static mesh; split source assets before delivery: ' + source['file'])
    mesh = meshes[0]
    for asset in imported:
        save_asset(asset)
    if not assets.rename_asset(mesh.get_path_name(), dest):
        raise RuntimeError('Cannot name generated mesh ' + name)
    mesh = unreal.load_asset(dest)
    save_asset(mesh)
    return mesh


def geometry_spline(actor, node):
    spline = actor.get_component_by_class(unreal.SplineComponent)
    if not spline:
        subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
        handles = subsystem.k2_gather_subobject_data_for_instance(actor)
        handle, failure = subsystem.add_new_subobject(unreal.AddNewSubobjectParams(parent_handle=handles[0], new_class=unreal.SplineComponent))
        data = unreal.SubobjectDataBlueprintFunctionLibrary.get_data(handle)
        spline = unreal.SubobjectDataBlueprintFunctionLibrary.get_associated_object(data)
        if not isinstance(spline, unreal.SplineComponent):
            raise RuntimeError('Cannot create editable scene spline: ' + str(failure))
    points = node['points'] if node['type']=='path' else [{'x':p[0],'y':0,'z':p[1]} for p in node['polygon']]
    spline.set_spline_points([vec(p) for p in points], unreal.SplineCoordinateSpace.LOCAL, True)
    for i in range(len(points)):
        spline.set_spline_point_type(i, unreal.SplinePointType.LINEAR, False)
    spline.set_closed_loop(node['type']!='path', True)
    spline.set_editor_property('component_tags', ['GripForge.Geometry', 'width_m:'+str(node.get('width',0))])


def environment(node):
    settings = plan['environment']; prefix = node['id']
    lighting = node.get('lighting', {})
    sun = new_actor(unreal.DirectionalLight, prefix+'_sun', node['name']+' · Sun', 'Environment')
    direction = vec(node.get('sky',{}).get('sun', {'x':-6,'y':6,'z':3}))
    sun.set_actor_rotation(unreal.MathLibrary.find_look_at_rotation(direction,unreal.Vector()), False)
    sun.light_component.set_intensity(settings['sun_lux'])
    sun.light_component.set_light_color(rgb(lighting.get('sunColor','#ffffff')))
    sun.light_component.set_editor_property('atmosphere_sun_light', True)
    sky = new_actor(unreal.SkyLight, prefix+'_sky', node['name']+' · Sky light', 'Environment')
    sky.light_component.set_intensity(settings['sky_intensity'])
    sky.light_component.set_editor_property('real_time_capture', True)
    new_actor(unreal.SkyAtmosphere, prefix+'_atmosphere', node['name']+' · Atmosphere', 'Environment')
    if node.get('fog'):
        fog = new_actor(unreal.ExponentialHeightFog, prefix+'_fog', node['name']+' · Fog', 'Environment')
        fog.component.set_editor_property('fog_density', settings['fog_density'])
        fog.component.set_editor_property('fog_inscattering_luminance', rgb(node['fog']['color']))
    pp = new_actor(unreal.PostProcessVolume, prefix+'_exposure', node['name']+' · Exposure', 'Environment')
    pp.set_editor_property('unbound', True)
    post = pp.get_editor_property('settings')
    extended=unreal.SystemLibrary.get_console_variable_int_value('r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange')==1
    exposure=exposure_brightness(settings['exposure_ev100'],extended)
    for prop, value in [('override_auto_exposure_min_brightness',True),('override_auto_exposure_max_brightness',True),
                         ('auto_exposure_min_brightness',exposure),('auto_exposure_max_brightness',exposure),
                         ('override_auto_exposure_bias',True),('auto_exposure_bias',0.0),
                         ('override_bloom_intensity',True),('bloom_intensity',settings['bloom_intensity'])]:
        post.set_editor_property(prop,value)
    pp.set_editor_property('settings',post)


def build_node(node):
    key, kind = node['id'], node['type']
    if key in existing and finished(existing[key]) and kind!='environment':
        return
    source = None
    group = nodes.get(node['parentId'], {}).get('name', kind.title())
    if kind in ('asset', 'terrain'):
        ref = node['asset'] if kind=='asset' else next(t for t in plan['terrains'] if t['nodeId']==key)
        source, resource = sources[(ref['assetId'], ref['revisionId'])]
        cls = resource if source['kind']=='native_actor' else unreal.StaticMeshActor
        actor = new_actor(cls, key, node['name'], group)
        if source['kind']=='native_actor':
            for prop,value in plan.get('actor_properties',{}).get(key,{}).items():
                actor.set_editor_property(prop,value)
            if any(p['nodeId']==key and p.get('hide_static_meshes') for p in plan.get('vfx_previews',[])):
                for component in actor.get_components_by_class(unreal.StaticMeshComponent):
                    component.set_visibility(False,False)
        if source['kind']!='native_actor':
            actor.static_mesh_component.set_static_mesh(resource)
    elif kind=='primitive':
        shape = {'box':'Cube','sphere':'Sphere','cylinder':'Cylinder','plane':'Plane'}[node['shape']]
        actor = new_actor(unreal.StaticMeshActor, key, node['name'], group)
        actor.static_mesh_component.set_static_mesh(unreal.load_asset('/Engine/BasicShapes/'+shape))
        mat = dict(node['material'], id='primitive_'+key)
        actor.static_mesh_component.set_material(0,material(mat))
    elif kind=='camera':
        actor = new_actor(unreal.CameraActor, key, node['name'], 'Cameras')
        actor.camera_component.set_field_of_view(node['fov'])
    elif kind=='light':
        cls = {'point':unreal.PointLight,'directional':unreal.DirectionalLight,'ambient':unreal.SkyLight,'hemisphere':unreal.SkyLight}[node['lightKind']]
        actor = new_actor(cls,key,node['name'],group)
        actor.light_component.set_intensity(node['intensity'])
        actor.light_component.set_light_color(rgb(node['color']))
        actor.light_component.set_cast_shadows(node['shadows'])
        if node['lightKind']=='point':
            actor.light_component.set_attenuation_radius(node['range']*100)
    else:
        actor = new_actor(unreal.TargetPoint, key, node['name'], group)
    apply_transform(actor, matrices[key], source)
    if kind=='primitive':
        size = node['size']
        s = actor.get_actor_scale3d()
        # UE basic primitives are 100 cm across. Plane lies in native XY, as scene planes lie in XZ.
        actor.set_actor_scale3d(unreal.Vector(s.x*size[0],s.y*size[2],s.z*size[1]))
    if kind=='camera':
        parent = matrices[node['parentId']] if node['parentId'] else identity()
        target = point(parent,[node['target'][k] for k in 'xyz'])
        actor.set_actor_rotation(unreal.MathLibrary.find_look_at_rotation(actor.get_actor_location(),unreal.Vector(target[0]*100,target[2]*100,target[1]*100)),False)
    if kind in ('path','region','zone'):
        geometry_spline(actor,node)
    if kind=='environment':
        environment(node)
    if kind in ('primitive','terrain','asset') and hasattr(actor,'static_mesh_component'):
        mode = plan['collision'].get(key, 'complex' if kind=='terrain' else 'source')
        component = actor.static_mesh_component
        if mode=='complex':
            if not source or source['kind']!='glb':
                raise RuntimeError('Cannot change shared native collision data: '+key)
            mesh = component.static_mesh
            mesh.get_editor_property('body_setup').set_editor_property('collision_trace_flag',unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)
            save_asset(mesh)
        component.set_collision_profile_name('NoCollision' if mode=='none' else 'BlockAll')
        for binding in plan['material_bindings']:
            if binding['nodeId']==key:
                component.set_material(binding['slot'],materials[binding['materialId']])
    finish(actor,node)


def build():
    global world, existing
    progress('checking_sources', error=None)
    if plan['schema']!='gripforge.unreal-scene.v1' or any(not p.startswith('/Game/GripForge/Maps/') for p in (plan['target_level'],folder)):
        raise RuntimeError('Invalid native work output namespace')
    project = Path(plan['project_file']).resolve().parent
    current = Path(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())).resolve()
    if project != current:
        raise RuntimeError('The active Unreal project does not match the pinned delivery project')
    for source in plan['assets']:
        cancelled()
        path = Path(source['file']) if source['kind']=='glb' else project/'Content'/(source['path'][6:]+'.uasset')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=source['sha256']:
            raise RuntimeError('Source revision changed: '+source['assetId'])
    texture_files = {t['file']: t for m in plan['materials'] for t in m.get('textures', {}).values() if isinstance(t, dict)}
    for source in texture_files.values():
        cancelled()
        if hashlib.sha256(Path(source['file']).read_bytes()).hexdigest() != source['sha256']:
            raise RuntimeError('Texture revision changed: ' + source['assetId'])
    # Check every transform before creating a level, including shear / rotated non-uniform parents.
    for m in matrices.values():
        native_transform(m)
    resuming=assets.does_asset_exist(plan['target_level'])
    if resuming:
        # Loading a World with load_asset and retaining its Python wrapper across LoadLevel
        # prevents UE's old-world GC and crashes the editor. Inspect ownership after opening it.
        if not levels.load_level(plan['target_level']):
            raise RuntimeError('Cannot resume native work level')
    else:
        if not levels.new_level(plan['target_level']):
            raise RuntimeError('Cannot create native work level')
    opened_world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    if resuming and assets.get_metadata_tag(opened_world,'GripForgeJob')!=plan_hash:
        raise RuntimeError('Target level exists without this job ownership marker. Use a new versioned target.')
    world=opened_world
    assets.set_metadata_tag(world,'GripForgeJob',plan_hash)
    assets.set_metadata_tag(world,'GripForgeLifecycle','work')
    save()
    existing = {str(tag)[3:]:actor for actor in actors.get_all_level_actors() for tag in actor.tags
                if str(tag).startswith('gf:') and not str(tag).startswith(('gf:job:','gf:data:')) and str(tag)!='gf:complete'}
    progress('importing_assets',level_created=True,completed_assets=0,total_assets=len(plan['assets']))
    for index,source in enumerate(plan['assets']):
        cancelled()
        progress('importing_assets',completed_assets=index,current_asset=source['assetId'])
        if source['kind']=='glb':
            resource=imported_mesh(source)
        elif source['kind']=='native_actor':
            resource=unreal.load_class(None, source['path']+'.'+source['path'].rsplit('/',1)[1]+'_C')
        else:
            resource=unreal.load_asset(source['path'])
        if not resource:
            raise RuntimeError('Cannot load asset '+source['assetId'])
        sources[(source['assetId'],source['revisionId'])]=(source,resource)
    progress('building_materials',completed_assets=len(plan['assets']),current_asset=None)
    for index,definition in enumerate(plan['materials']):
        cancelled()
        progress('building_materials', completed_materials=index, total_materials=len(plan['materials']), current_material=definition['id'])
        material(definition)
    progress('building_materials', completed_materials=len(plan['materials']), current_material=None, imported_texture_files=len(texture_files))
    ordered=sorted(nodes.values(),key=lambda n: 0 if n['type']=='terrain' else 1 if n['type']=='group' else 2)
    for index,node in enumerate(ordered):
        cancelled()
        build_node(node)
        if index%40==0:
            save()
            progress('placing_nodes',completed_nodes=index+1,total_nodes=len(nodes),progress=round((index+1)/len(nodes)*.85,3))
    for node in nodes.values():
        if node['parentId']:
            parent_actor=existing[node['parentId']]
            if isinstance(parent_actor,unreal.TargetPoint):
                parent_actor.root_component.set_mobility(unreal.ComponentMobility.STATIC)
            if not existing[node['id']].attach_to_actor(parent_actor, '', unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, False):
                raise RuntimeError('Cannot preserve native scene hierarchy: '+node['id'])
    for override in plan.get('niagara_overrides',[]):
        matched=0
        for component in existing[override['nodeId']].get_components_by_class(unreal.NiagaraComponent):
            system=component.get_asset()
            if not system or system.get_path_name().split('.')[0]!=override['system']:
                continue
            for name,value in override['colors'].items():
                component.set_variable_linear_color(name,rgb(value['color'],value['intensity']))
            matched+=1
        if not matched:
            raise RuntimeError('Niagara system not found on requested instance: '+override['nodeId'])
    for start in plan['gameplay']['player_starts']:
        node=nodes[start['nodeId']]
        actor=new_actor(unreal.PlayerStart,'start_'+node['id'],node['name']+' · Player start','Spawn Zones')
        apply_transform(actor,matrices[node['id']])
        actor.set_actor_location(actor.get_actor_location()+vec(start['offset']),False,True)
        actor.set_editor_property('player_start_tag','gf:start_'+node['id'])
        finish(actor)
    mode=plan['gameplay'].get('game_mode')
    if mode:
        cls=unreal.load_class(None,mode)
        if not cls:
            raise RuntimeError('Missing gameplay class '+mode)
        world.get_world_settings().set_editor_property('default_game_mode',cls)
    active=existing.get(plan['document'].get('activeCameraId'))
    if isinstance(active,unreal.CameraActor):
        unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(active.get_actor_location(),active.get_actor_rotation())
    save()
    measurements={}
    for node in nodes.values():
        if node['type']=='terrain':
            lo,hi=existing[node['id']].static_mesh_component.get_local_bounds()
            measured=[(hi.x-lo.x)/100,(hi.y-lo.y)/100]
            if any(abs(a-b)>.1 for a,b in zip(measured,node['size'])):
                raise RuntimeError('Terrain metre/centimetre mismatch: '+str(measured))
            measurements[node['id']]=measured
    checked=0
    for node in nodes.values():
        if node['type'] not in ('asset','terrain'):
            continue
        ref=node['asset'] if node['type']=='asset' else next(t for t in plan['terrains'] if t['nodeId']==node['id'])
        source,_=sources[(ref['assetId'],ref['revisionId'])]
        t,q,s=native_transform(matrices[node['id']],source)
        actor=existing[node['id']]
        location,scale=actor.get_actor_location(),actor.get_actor_scale3d()
        rotation=actor.get_actor_rotation().quaternion()
        delta=max(abs(t[i]-getattr(location,k)) for i,k in enumerate('xyz'))
        scale_delta=max(abs(s[i]-getattr(scale,k)) for i,k in enumerate('xyz'))
        dot=abs(sum(q[i]*getattr(rotation,k) for i,k in enumerate('xyzw')))
        if delta>1 or scale_delta>1e-4 or dot<.99999:
            raise RuntimeError('Construction or attachment changed transform of '+node['id']+'. Bind its editable Blueprint parameters in actor_properties. Delta: '+str((delta,scale_delta,dot)))
        checked+=1
    progress('verifying_gameplay',gameplay_validation=dict(status='pending'),completed_nodes=len(nodes),total_nodes=len(nodes),progress=.9,terrain_m=measurements,verified_instance_transforms=checked,actor_count=len(existing))


def warmup_vfx():
    count=0
    for preview in plan.get('vfx_previews',[]):
        components=existing[preview['nodeId']].get_components_by_class(unreal.NiagaraComponent)
        if not components:
            raise RuntimeError('No Niagara components on requested VFX preview: '+preview['nodeId'])
        for component in components:
            component.set_force_solo(True)
            component.set_paused(False)
            component.reinitialize_system()
            component.activate(True)
            component.advance_simulation_by_time(preview['warmup_seconds'],1/60)
            component.set_paused(True)
            count+=1
    state['previewed_vfx_components']=count


try:
    build()
    captures=job_dir/'captures'; captures.mkdir(exist_ok=True)
    queue=list(plan['capture']['camera_ids'])
    captured=[]
    next_shot=time.monotonic()+20
    pending=None
    pending_deadline=0
    pending_started=0
    capture_busy=False
    spawn_review=None
    gameplay_checked=False
    def review_gameplay():
        global spawn_review,gameplay_checked
        if gameplay_checked:
            return True
        config=plan['gameplay'].get('spawn_review',{})
        starts=plan['gameplay']['player_starts']
        if not starts or not config.get('enabled',True):
            result=dict(status='not_run',reason='no_player_starts' if not starts else 'disabled_in_plan')
        else:
            if spawn_review is None:
                expected=[]
                for start in starts:
                    location=existing['start_'+start['nodeId']].get_actor_location()
                    expected.append(dict(id=start['nodeId'],position=[location.x,location.y,location.z]))
                spawn_review=SpawnReview(expected,config.get('duration_seconds',6),config.get('tolerance_cm',200),config.get('require_grounded',True))
            if spawn_review.started_at is None:
                if not spawn_review.start():
                    progress('waiting_for_editor',reason='Spawn review waits for the active user play session to end.')
                    return False
                progress('verifying_gameplay',reason='Testing the actual GameMode spawn and floor contact in Play in Editor.')
                return False
            result=spawn_review.poll()
            if result is None:
                return False
        (job_dir/'gameplay-review.json').write_text(json.dumps(result,indent=2))
        progress('verifying_gameplay',gameplay_validation=result,reason=None)
        if result['status']=='failed':
            raise RuntimeError('Gameplay spawn review failed: '+', '.join(result['issues'])+'. Inspect gameplay-review.json; check GameMode spawn overrides and terrain collision.')
        gameplay_checked=True
        return True
    def tick(_dt):
        global next_shot,pending,capture_busy,pending_deadline,pending_started
        if capture_busy or time.monotonic()<next_shot:
            return
        capture_busy=True
        try:
            cancelled()
            if not review_gameplay():
                next_shot=time.monotonic()+.2
                return
            # A user can start PIE while reviewing the imported level. Automation
            # then captures the game's viewport, even when an editor camera was
            # supplied. Preserve the play session and retry its interrupted view.
            if levels.is_in_play_in_editor():
                if pending:
                    queue.insert(0,pending)
                    pending=None
                if state.get('stage')!='waiting_for_editor':
                    progress('waiting_for_editor',reason='Play in Editor is active; camera captures resume when it stops.',captures=captured)
                next_shot=time.monotonic()+3
                return
            if pending:
                file=captures/(pending+'.png')
                if not file.exists() or file.stat().st_size<1024 or file.stat().st_mtime<pending_started:
                    if time.monotonic()<pending_deadline:
                        next_shot=time.monotonic()+2
                        return
                    raise RuntimeError('Unreal did not produce requested viewport capture within 180 seconds: '+pending)
                captured.append(str(file)); pending=None
            if not queue:
                unreal.unregister_slate_post_tick_callback(tick_handle)
                for preview in plan.get('vfx_previews',[]):
                    for component in existing[preview['nodeId']].get_components_by_class(unreal.NiagaraComponent):
                        component.set_paused(False)
                        component.set_force_solo(False)
                active=existing.get(plan['document'].get('activeCameraId'))
                if isinstance(active,unreal.CameraActor):
                    unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(active.get_actor_location(),active.get_actor_rotation())
                progress('awaiting_visual_review',progress=1,captures=captured)
                return
            key=queue.pop(0); camera=existing[key]
            # Automation capture pumps editor ticks. Reserve the camera before calling UE to
            # prevent a nested tick from consuming the other views or claiming completion early.
            pending=key; pending_started=time.time();next_shot=time.monotonic()+15;pending_deadline=time.monotonic()+180
            progress('capturing',current_camera=key,captures=captured,reason=None)
            warmup_vfx()
            unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(camera.get_actor_location(),camera.get_actor_rotation())
            unreal.AutomationLibrary.take_high_res_screenshot(plan['capture']['width'],plan['capture']['height'],str(captures/(key+'.png')),camera=camera)
            # Shader/PSO compilation may block the call longer than the initial warmup.
            # Start the file wait only after UE has returned to its event loop.
            next_shot=time.monotonic()+5
            pending_deadline=time.monotonic()+180
        except Exception as error:
            if spawn_review:
                spawn_review.close()
            unreal.unregister_slate_post_tick_callback(tick_handle)
            progress('cancelled' if isinstance(error,InterruptedError) else 'failed',error=traceback.format_exc(),captures=captured)
        finally:
            capture_busy=False
    tick_handle=unreal.register_slate_post_tick_callback(tick)
except Exception as error:
    save()
    progress('cancelled' if isinstance(error,InterruptedError) else 'failed',error=traceback.format_exc())
    unreal.log_error(traceback.format_exc())
