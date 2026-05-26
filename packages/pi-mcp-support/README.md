# @codella/pi-mcp-support

Generic Model Context Protocol (MCP) support extension for [Pi](https://pi.dev).

It connects configured MCP servers and registers each server tool as a Pi tool named:

```text
mcp_<server>_<tool>
```

It also exposes helper tools for MCP status, resources, and prompts.

## Install

```bash
pi install npm:@codella/pi-mcp-support
```

## Configuration

Create a project config:

```text
.pi/mcp.json
```

Or a global config:

```text
~/.pi/agent/mcp.json
```

Legacy global config is also supported:

```text
~/.pi/mcp.json
```

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

## Server config

```ts
type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  transport?: "stdio" | "streamable-http" | "sse";
  headers?: Record<string, string>;
  disabled?: boolean;
};
```

- If `url` is present, transport defaults to `streamable-http`.
- Without `url`, transport defaults to `stdio` and requires `command`.
- Environment variables in config values can be referenced as `${NAME}`.

## Commands

- `/mcp` - Show loaded config and a compact connected-server/tool-count summary.
- `/mcp help` or `/mcp --help` - Show command usage.
- `/mcp tools` - Show registered tool names, limited to the first 25 tools per server.
- `/mcp tools <server>` - Show registered tool names for one server.
- `/mcp tools --all` - Show all registered tool names.
- `/mcp tools <server> --all` - Show all registered tool names for one server.

## Built-in helper tools

- `mcp_status`
- `mcp_read_resource`
- `mcp_list_resources`
- `mcp_list_prompts`
- `mcp_get_prompt`

## License

MIT
