# @gripforgeai/mcp

Attach weapons & props to rigged characters — from Claude Code, Cursor or any
MCP client. Thin client for the [GripForge](https://gripforge.ai) API.

## Install (Claude Code)

```bash
claude mcp add gripforge -e GRIPFORGE_API_KEY=gf_... -- npx -y @gripforgeai/mcp
```

Or in `.mcp.json`:

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

Get a free API key (3 attaches / month) at https://gripforge.ai/login.

## Tools

- `gripforge_attach` — character + prop in, bone-local bind + Three.js / Unity /
  Godot snippets out. Styles: melee, gun, shield, staff (scythe/polearm).
- `gripforge_formats` — supported formats & options.

## Env

- `GRIPFORGE_API_KEY` (required) — 1 credit = 1 successful attach
- `GRIPFORGE_API_URL` (optional) — defaults to https://gripforge.ai
