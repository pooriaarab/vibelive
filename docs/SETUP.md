# Setup

How to install vibelive and wire up its MCP server on macOS, Windows, and Linux.

## What you need

- Node.js 18 or newer (`node --version` to check).
- An agentic coding CLI or Claude Desktop, if you want the MCP server.

vibelive lets you share a live multiplayer terminal by URL.

## Install

You don't have to install anything. `npx` runs the latest published version:

```
npx vibelive --help
```

To get a persistent `vibelive` command, install it globally:

```
npm install -g vibelive
```

## MCP setup

The MCP server lets an agent drive vibelive through tool calls instead of a terminal.
The server starts with the `vibelive mcp` subcommand.

### Claude Code (all platforms)

One command, no file editing:

```
# macOS and Linux
claude mcp add vibelive -- npx -y vibelive@latest mcp

# Windows
claude mcp add vibelive -- cmd /c npx -y vibelive@latest mcp
```

### Claude Desktop (editing the config file)

Open the config file, add the `vibelive` block, then fully quit and reopen Claude.

**macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vibelive": { "command": "npx", "args": ["-y", "vibelive@latest", "mcp"] }
  }
}
```

**Linux** — `~/.config/Claude/claude_desktop_config.json`: same as macOS.

**Windows** — `%APPDATA%\Claude\claude_desktop_config.json` (paste that into the
Explorer address bar, open with Notepad):

```json
{
  "mcpServers": {
    "vibelive": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "vibelive@latest", "mcp"]
    }
  }
}
```

### Two things that break MCP on Windows

Most "MCP failed" or "not connected" reports on Windows come down to one of these.

1. **`"command": "npx"` on its own doesn't work.** Windows can't run `npx`
   directly, so the server never starts. Wrap it: `"command": "cmd"` with
   `"args": ["/c", "npx", ...]`. macOS and Linux don't need this.
2. **A stale cached version.** `npx` caches packages, so it can keep serving an
   old build. `vibelive@latest` forces the current release.

## Check it works

```
vibelive --version
```

If the MCP server won't connect, run `npx -y vibelive@latest mcp` in a terminal on its own.
It should start and wait for input rather than exiting straight away.
