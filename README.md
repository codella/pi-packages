# Codella Pi Packages

A monorepo of Pi packages published under the `@codella` npm scope.

## Packages

| Package | Type | Description |
| --- | --- | --- |
| `@codella/pi-theme-cyberpunk` | Theme | Neon cyberpunk TUI theme for Pi. |
| `@codella/pi-theme-candy` | Theme | Dark pastel candy TUI theme for Pi. |
| `@codella/pi-prompt-plan` | Prompt template | `/plan` prompt command for explicit plan-first workflows. |
| `@codella/pi-mcp-support` | Extension | Generic Model Context Protocol (MCP) support for Pi. |

## Install

Install packages individually:

```bash
pi install npm:@codella/pi-theme-cyberpunk
pi install npm:@codella/pi-theme-candy
pi install npm:@codella/pi-prompt-plan
pi install npm:@codella/pi-mcp-support
```

After installing a theme, select it from `/settings` or set one of the theme names in Pi settings:

```json
{
  "theme": "cyberpunk"
}
```

```json
{
  "theme": "candy"
}
```

## MCP configuration

`@codella/pi-mcp-support` reads MCP servers from:

1. Project config: `.pi/mcp.json`
2. Global Pi config: `~/.pi/agent/mcp.json`
3. Legacy global config: `~/.pi/mcp.json`

Example:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

## Development

Validate package metadata and theme tokens:

```bash
npm run validate
```

Dry-run package tarballs:

```bash
npm run pack:dry-run
```

Or one package at a time:

```bash
npm run pack:theme
npm run pack:candy
npm run pack:plan
npm run pack:mcp
```

## Publishing

Publish one package at a time from this workspace after reviewing `npm pack --dry-run` output:

```bash
npm publish -w @codella/pi-theme-cyberpunk --access public
npm publish -w @codella/pi-theme-candy --access public
npm publish -w @codella/pi-prompt-plan --access public
npm publish -w @codella/pi-mcp-support --access public
```

Do not publish without explicit confirmation.

## License

MIT
