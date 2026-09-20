# @gripforgeai/mcp

**The tools your AI needs to make your games.**

Turn prompts into production-ready game assets — rigged characters, attached weapons, seamless textures, terrain, VFX, HUDs — and playable game kits.

MCP client for the [GripForge](https://gripforge.ai) API — from Claude Code, Cursor, Windsurf, VS Code or any MCP client.

## Hosted endpoint (zero install)

No Node required — point any remote-capable MCP client at:

```
https://gripforge.ai/mcp
```

Auth: `x-api-key: gf_...` header (or `Authorization: Bearer`). Assets are passed
as **URLs** (`character_url`, `prop_url`) — Tripo/Meshy download links work
directly.

```jsonc
// Cursor (.cursor/mcp.json)
{
  "mcpServers": {
    "gripforge": {
      "url": "https://gripforge.ai/mcp",
      "headers": { "x-api-key": "gf_..." }
    }
  }
}
```

## Example

> "Attach this sword to my knight, right hand, then export the armed GLB."

The agent calls `gripforge_attach` with the two asset URLs (or local paths with
the npm package); GripForge finds the hand bone, scales the prop to the
character's hand, closes the fist around the grip and returns the bind JSON,
ready-to-paste Three.js / Unity / Godot snippets, and optionally the armed GLB.

To forge a character **from a picture** (not from a text prompt), pass
`concept_item` (a Library `lib_…` T-pose/concept), or with the npm package a
local `path` / `file_url`. That is Meshy image-to-3D. Without those fields the
tool is text-to-3D only.

## Install (any MCP client)

Add the server to your client's MCP config (`.mcp.json`, `mcp.json`, settings — the shape is the same everywhere):

```json
{
  "mcpServers": {
    "gripforge": {
      "command": "npx",
      "args": ["-y", "@gripforgeai/mcp"],
      "env": { "GRIPFORGE_API_KEY": "gf_..." }
    }
  }
}
```

Get an API key at https://gripforge.ai/login — Free: 15 Studio attaches + **3 API/MCP trial attaches / month**. Credit packs from €29 (100 credits, never expire).

## Install (Grok)

```bash
grok mcp add gripforge --env GRIPFORGE_API_KEY=gf_... -- npx -y @gripforgeai/mcp
```

Or in `~/.grok/config.toml`:

```toml
[mcp_servers.gripforge]
command = "npx"
args = ["-y", "@gripforgeai/mcp"]
enabled = true
startup_timeout_sec = 45

[mcp_servers.gripforge.env]
GRIPFORGE_API_KEY = "gf_..."
```

Also works with Cursor, Windsurf and any MCP-compatible client — same
`command` / `args` / `env` triple.


## Tools

Hosted HTTP MCP (`https://gripforge.ai/mcp`) is always current. This npm package
writes files into the repo (`out_dir`), including `gripforge_hud`,
`gripforge_hud_bar` and `gripforge_cape`. Hosted-only: `gripforge_make_seamless`.
Full list: https://gripforge.ai/mcp-docs

- `gripforge_style_kit` — resolve "Devil May Cry like" / "genshin" to locker ids
  already tagged with that look. **Call this before generating.** Reuse the ids.
- `gripforge_generate_character` — new T-pose + auto-rig into Library (10 credits).
  `kind=enemy` or the word "enemy" in the prompt. Skip this if style_kit already
  returned a character.
- `gripforge_boss` — playable boss kit (stats, phases, attacks, arena, engine snippets).
  0 credits. Reuses a locker enemy. `generate=true` forges a new kind=enemy (10 credits).
  Then `gripforge_animate` with the returned archetype.
- `gripforge_concept_correct` — concept image → strict T-pose sheet (1 credit).
- `gripforge_attach` — character + prop (paths or Library ids) in, bone-local bind + Three.js / Unity /
  Godot snippets out. Styles: melee, gun, shield, staff (scythe/polearm).
  `attach_id` reuses an armed bind as the character; `prop_id_2` / `prop_path_2` attaches a second
  held item (off-hand). With `export_glb: true` (+ `out_dir`) it also writes `attached.glb`: the
  character with the fist closed and the prop attached, textures preserved —
  use this for mitten-hand rigs, whose closed fist cannot travel in a JSON bind.
- `gripforge_loadout` — multi-weapon character in one call (sets + manifest + clips). 1 credit / prop.
- `gripforge_generate_weapon` — Meshy weapon GLB into Library (kind=weapon, polycount, style=melee|gun). 10 credits. Not generate_character.
- `gripforge_hud` — survivor HUD kit (`hud.json` + PNGs + `.tscn` + snippets). Writes `out_dir` (default `./gripforge-hud`). 1 credit.
- `gripforge_hud_bar` — original themed health-bar frame+fill PNGs. Writes `out_dir`. 2 credits.
- `gripforge_cape` — cape bone grid + skinned `attached_cape.glb` + Godot/Three snippets. Writes `out_dir` (default `./gripforge-cape`). 1 credit.
- `gripforge_formats` — supported formats & options.
- `gripforge_library_list` / `get` / `push` / `pull` / `tag` — the Library locker.
  `kind=animation|audio` is valid. `pull` writes the mesh **and VFX sidecars** (`tex0..png/json`)
  into the open repo (`out_dir`, default `./gripforge-library`).
  Saving a bind after attach is not a second credit.
- `gripforge_audio_kit` — locker SFX + music for a game look. Free.
- `gripforge_animate` — clip pack onto a Mixamo Library char (archetype sword/claws/heavy/brawler/puppet). 0 credits.
- `gripforge_retarget` — clip from skeleton A onto skeleton B.
- `gripforge_rest_pose` — arms-down rest computed against this mesh (weapons stay on an armed bind).
- `gripforge_render` — server PNG preview so the agent can see without a browser.
- `gripforge_scene_kit` — locker props + suggested layout for a game look.
- `gripforge_light_kit` / `gripforge_font` / `gripforge_navmesh` — lights+fog, webfont+ranks, walkable AABB. 0 credits.
- `gripforge_input_kit` — FPS InputMap (WASD + arrows). Write input.json, autoload GfInput.
  Optional `third_person: true` adds portable character-facing JavaScript and a
  Three.js integration example; the existing input map is unchanged. 0 credits.
- `gripforge_viewmodel_kit` — CS-style FPS arms + gun under Camera3D/Hold. Write viewmodel.json + gf_viewmodel.gd. 0 credits.
- `gripforge_loading_page` — overlay html/css/js + Godot/Unity/Unreal. Pass `character_id` for a 16:9 still (1 credit).
- `gripforge_level` — playable room graph from a prompt. 0 credits.
- `gripforge_map_plan` — top-down FPS/bomb map (spawns, sites A/B, lanes, walls). Preview: https://gripforge.ai/map-plan?prompt=dust2. 0 credits.
- `gripforge_map_wires` — sagging electrical spans (2 anchors + sag), not a cable mesh. Pair with map_plan. 0 credits.
- `gripforge_map_look` — still → camera + dressing ids (shot21a A-site). LINK only, never Meshy image-to-3d. 0 credits.
- `gripforge_map_reconstruct` — collect → graph → greybox → zone → camera match → dress. Dust II Valve IP: greybox benchmark only, no BSP. stage=dress = original textures + props + wires. 0 credits.
- `gripforge_hitbox` — body capsules + `weapons[]` from a bind or loadout.
- `gripforge_texture_prep` — local path or `texture_id` → seamless blend + faithful
  lanczos upscale (1×/2×/4×, max 1024 or 2048). Writes the PNG into `out_dir` and
  returns the Library albedo URL. Not a generator. No credit.
- `gripforge_vfx_generate` — use `preset` set to `slash-trail`, `slash-steel`, `slash-fire`, `slash-ice` or `slash-nature` alone for a ready-to-play recipe without AI; otherwise text/image to an editable animated VFX specification (admin keys). Accepts `prompt`, `visual_style`, and either a base64 `image_data` or an owned Library `image_id`.
- `gripforge_vfx` / `gripforge_vfx_preview` — save/export and sample VFX (admin keys). Pass generated `emitters` and `generation` along with the effect parameters to preserve the generated result.
- `gripforge_shaders` — list the authorized shader catalog (`{ id, name, engines }`). Search `q=slash_reveal`.
- `gripforge_shader_pull` — `id` + `engine` (`godot`|`unity`|`three`) + `out_dir` →
  write sources into the repo and return an assignment snippet. **v1 pull is free**.
- `gripforge_performance` — analyze measured game FPS, frame timing, CPU/render
  submission, optional GPU timing and network latency. Retrieve an explicitly
  shared workspace capture or provide a report directly. 0 credits.

### Game Kits (modular)

Composable gameplay kits (`vehicle.driveable`, `mission.objectives`, `npc.wanted`…)
installed into a Game Kit project (`gkp_…`) with dependency resolution, a lockfile
and a browser play URL, then delivered into Godot, Unity or Unreal projects. All 0 credits
except the first delivery of a kit major version to an engine (1 credit per workspace).
Full parameters: https://gripforge.ai/mcp-docs

- `gripforge_gamekit_search` — **start here**: search the catalogue by text, capability, tag or target; with `project_id` each hit carries its install state.
- `gripforge_gamekit_get` — manifest, README, config schema + defaults, versions of one kit (`with_usage` lists the projects using it).
- `gripforge_gamekit_install` — add a kit to a project; manifest dependencies are resolved automatically (`dry_run` to preview).
- `gripforge_gamekit_remove` — uninstall a kit (`force` past `kit_in_use`, `prune` orphaned dependencies).
- `gripforge_gamekit_configure` — merge config values or toggle `enabled` without uninstalling.
- `gripforge_gamekit_dependencies` — dependency graph of a project, or the manifest tree of a catalogue kit.
- `gripforge_gamekit_update` — update plan (dry-run) or `apply=true` to write the lockfile and run migrations; omit `id` for all kits.
- `gripforge_gamekit_deliver` — plan (`dry_run`) then bundle of engine files for `godot` / `unity` / `unreal` (`web` is native); write `bundle.files` following `plan.actions`.
- `gripforge_gamekit_deliver_local` (this npm client only) — same delivery straight into `project_dir`: hashes `gripforge/**`, reads the lock, executes the actions with backups in `gripforge/.backup/<plan id>/`, `verify=true` runs Godot headless when `GODOT_BIN` is set.
- `gripforge_gamekit_rollback_local` (this npm client only) — restore the backups of the last delivery and put the previous lock back.
- `gripforge_game_capabilities` — what the project provides, what is missing for a goal and which kits fill each gap.
- `gripforge_game_project` — `action=list|create|get|bind|data|delete` on projects (bindings slot → `lib_…`, data collections, `confirm=true` to delete).
- `gripforge_game_play_url` — browser play URL of the project's current revision (`{ url, absolute }`).

## Character facing for third-person games

Call `gripforge_input_kit` with `{ "prompt": "third person", "third_person": true }`.
Save the returned `third_person.source_js` as `character-facing.js`; it exports:

```js
// Keep this object for the lifetime of one character.
const facingState = { velocity: 0, targetYaw: currentYaw };
updateCharacterFacing(currentYaw, {
  moveX, moveZ, lookYaw, aiming, firing, building
}, dtSeconds, facingState)
```

Pass world-space movement with **-Z forward**, angles in radians and elapsed time
in seconds. Free movement turns the character toward its travel direction;
standing still finishes the last turn and retains that heading. Aiming, firing
or building turns it toward `lookYaw`. Turning follows the shortest arc with
bounded angular speed and acceleration, retaining continuous analog directions.
Elapsed time is capped at 0.1 seconds after a long pause. The optional state adds
smooth acceleration and braking; older three-argument calls still work with a
speed cap. Reset the state after a teleport or character replacement.

The returned `usage_three` rotates an outer avatar group, preserving the imported
model's quaternion and keeping camera control independent. This helper supplies
orientation only. Keep your existing movement, physics, collision, camera and
network systems. Omitting `third_person`, or setting it to `false`, returns the
existing input kit without the additional section. The option is available in
the hosted MCP and this source checkout; it is not in published npm `0.1.5`.

## Performance diagnostics

`gripforge_performance` is included in this source checkout and the hosted MCP.
The published npm `0.1.5` package does not include it. Use the hosted endpoint
above, or build this checkout with `pnpm --filter @gripforgeai/mcp build` and
configure your MCP client to run `node` with the absolute path to
`packages/mcp-client/dist/server.js`. Deploying the website does not update an
installed npm package.

To retrieve the latest capture explicitly shared from a game in the API key's
workspace:

```json
{ "kit_id": "lib_your_kit_id" }
```

Omit `kit_id` to use that workspace's latest capture. If none is available, the
tool asks for a capture or a report; it does not manufacture measurements.
Alternatively, provide copied diagnostic JSON:

```json
{
  "report": {
    "game": "Eclat Royale",
    "viewport": { "width": 1920, "height": 1080 },
    "samples": [
      { "fps": 32, "frameMs": 31.25, "p95Ms": 48, "cpuMs": 12, "submitMs": 7, "networkMs": 65 },
      { "fps": 34, "frameMs": 29.41, "p95Ms": 43, "cpuMs": 11, "submitMs": 6, "networkMs": 70 },
      { "fps": 31, "frameMs": 32.26, "p95Ms": 50, "cpuMs": 13, "submitMs": 8, "networkMs": 62 }
    ]
  }
}
```

These example values illustrate the format. Supply measurements from the affected
game session. A report accepts 1–120 samples and each sample needs `fps` or
`frameMs`. Optional fields are `pixelRatio`, `quality`, `level`, `gpuMs`,
`drawCalls`, `triangles` and `snapshotAgeMs`, as well as the timing fields above.
The tool strips unrecognized report fields before sending the report to
GripForge. Explicit reports use analysis mode and are not saved as captures.

Results separate measured findings from recommendations. Renderer submission is
CPU/driver time already included in `cpuMs`; `gpuMs` is meaningful only when
actually measured. This tool does not control a browser, change game settings,
publish code or automatically fix a game.

## Env

- `GRIPFORGE_API_KEY` (required) — 1 credit = 1 successful attach
- `GRIPFORGE_API_URL` (optional) — defaults to https://gripforge.ai
