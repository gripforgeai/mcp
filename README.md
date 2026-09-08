# @gripforgeai/mcp

Attach weapons & props to rigged characters — from Cursor, Windsurf, VS Code or any
MCP client. Thin client for the [GripForge](https://gripforge.ai) API.

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

Get a free API key at https://gripforge.ai/login — the free plan includes **3 API/MCP attaches per month** to try it out (plus 15 in the web Studio). Paid plans from €29/mo for production use.

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

- `gripforge_style_kit` — resolve "Devil May Cry like" / "genshin" to locker ids
  already tagged with that look. **Call this before generating.** Reuse the ids.
- `gripforge_generate_character` — new T-pose + auto-rig into Library (10 credits).
  `kind=enemy` or the word "enemy" in the prompt. Skip this if style_kit already
  returned a character.
- `gripforge_concept_correct` — concept image → strict T-pose sheet (1 credit).
- `gripforge_attach` — character + prop (paths or Library ids) in, bone-local bind + Three.js / Unity /
  Godot snippets out. Styles: melee, gun, shield, staff (scythe/polearm).
  With `export_glb: true` (+ `out_dir`) it also writes `attached.glb`: the
  character with the fist closed and the prop attached, textures preserved —
  use this for mitten-hand rigs, whose closed fist cannot travel in a JSON bind.
- `gripforge_formats` — supported formats & options.
- `gripforge_library_list` / `get` / `push` / `pull` — the Library locker.
  `pull` writes bind.json + mesh into the open repo (`out_dir`, default `./gripforge-library`).
  Saving a bind after attach is not a second credit.
- `gripforge_texture_prep` — local path or `texture_id` → seamless blend + faithful
  lanczos upscale (1×/2×/4×, max 1024 or 2048). Writes the PNG into `out_dir` and
  returns the Library albedo URL. Not a generator. No credit.
- `gripforge_vfx` / `gripforge_vfx_preview` — strike VFX (admin keys).
- `gripforge_shaders` — list the authorized shader catalog (`{ id, name, engines }`). Search `q=slash_reveal`.
- `gripforge_shader_pull` — `id` + `engine` (`godot`|`unity`|`three`) + `out_dir` →
  write sources into the repo and return an assignment snippet. **v1 pull is free**.

## Env

- `GRIPFORGE_API_KEY` (required) — 1 credit = 1 successful attach
- `GRIPFORGE_API_URL` (optional) — defaults to https://gripforge.ai
