import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Generic MCP support for pi.
 *
 * Configuration is read from .pi/mcp.json first, then ~/.pi/agent/mcp.json,
 * then legacy ~/.pi/mcp.json.
 *
 * Example:
 * {
 *   "servers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
 *       "env": { "FOO": "bar" }
 *     },
 *     "remote": {
 *       "url": "http://localhost:3000/mcp",
 *       "transport": "streamable-http",
 *       "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
 *     }
 *   }
 * }
 */

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

type McpConfig = {
  servers?: Record<string, ServerConfig>;
};

type ConnectedServer = {
  name: string;
  config: ServerConfig;
  client: Client;
  toolNames: string[];
};

const VERSION = "0.1.0";
const DEFAULT_TOOL_LIST_LIMIT = 25;
const connected = new Map<string, ConnectedServer>();
const registeredToolNames = new Set<string>();

function sanitizeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "server";
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? "");
}

function cleanProcessEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function expandRecordEnv(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandEnv(value)]));
}

function configPath(cwd: string): string | undefined {
  const project = resolve(cwd, ".pi/mcp.json");
  if (existsSync(project)) return project;

  const globalAgent = join(homedir(), ".pi/agent/mcp.json");
  if (existsSync(globalAgent)) return globalAgent;

  const legacyGlobal = join(homedir(), ".pi/mcp.json");
  if (existsSync(legacyGlobal)) return legacyGlobal;

  return undefined;
}

async function loadConfig(cwd: string): Promise<{ path?: string; config: McpConfig }> {
  const path = configPath(cwd);
  if (!path) return { config: {} };
  return { path, config: JSON.parse(await readFile(path, "utf8")) as McpConfig };
}

async function connectServer(name: string, config: ServerConfig, cwd: string): Promise<ConnectedServer> {
  const client = new Client({ name: `pi-mcp-${name}`, version: VERSION }, { capabilities: {} });
  const transportType = config.transport ?? (config.url ? "streamable-http" : "stdio");

  if (transportType === "stdio") {
    if (!config.command) throw new Error(`MCP server ${name} is missing command`);
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...cleanProcessEnv(), ...expandRecordEnv(config.env) },
        cwd: config.cwd ? resolve(cwd, config.cwd) : cwd,
        stderr: "pipe",
      }),
    );
  } else {
    if (!config.url) throw new Error(`MCP server ${name} is missing url`);
    const requestInit = { headers: expandRecordEnv(config.headers) } as RequestInit;
    const url = new URL(expandEnv(config.url));
    if (transportType === "sse") {
      await client.connect(new SSEClientTransport(url, { requestInit }));
    } else {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
    }
  }

  return { name, config, client, toolNames: [] };
}

function normalizeSchema(schema: unknown): object {
  if (!schema || typeof schema !== "object") {
    return Type.Object({}, { additionalProperties: true });
  }
  return schema as object;
}

function formatToolResult(result: unknown): string {
  const maybe = result as { content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean };
  if (!Array.isArray(maybe.content)) return JSON.stringify(result, null, 2);

  const parts = maybe.content.map((item) => {
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "image") return `[MCP image: ${item.mimeType ?? "unknown mime type"}]`;
    if (item.type === "audio") return `[MCP audio: ${item.mimeType ?? "unknown mime type"}]`;
    if (item.type === "resource") return `[MCP resource: ${JSON.stringify(item.resource)}]`;
    return JSON.stringify(item);
  });

  if (maybe.structuredContent !== undefined) {
    parts.push(`\nStructured content:\n${JSON.stringify(maybe.structuredContent, null, 2)}`);
  }
  if (maybe.isError) parts.unshift("MCP tool reported an error.");
  return parts.join("\n");
}

async function registerMcpServerTools(pi: ExtensionAPI, server: ConnectedServer) {
  const listed = await server.client.listTools();
  server.toolNames = [];

  for (const tool of listed.tools ?? []) {
    const piToolName = `mcp_${sanitizeName(server.name)}_${sanitizeName(tool.name)}`;
    if (registeredToolNames.has(piToolName)) continue;
    registeredToolNames.add(piToolName);
    server.toolNames.push(piToolName);

    pi.registerTool({
      name: piToolName,
      label: `MCP ${server.name}/${tool.name}`,
      description: tool.description ?? `Call MCP tool ${tool.name} on server ${server.name}`,
      promptSnippet: `Call MCP tool ${server.name}/${tool.name}`,
      promptGuidelines: [`Use ${piToolName} only when the MCP server ${server.name} provides the capability needed for the user's request.`],
      parameters: normalizeSchema(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        const result = await server.client.callTool(
          { name: tool.name, arguments: params as Record<string, unknown> },
          undefined,
          signal ? { signal } : undefined,
        );
        return {
          content: [{ type: "text", text: formatToolResult(result) }],
          details: { server: server.name, tool: tool.name, raw: result },
        };
      },
    });
  }
}

type NotifyLevel = "info" | "warning" | "error";

type McpCommandArgs =
  | { mode: "status" }
  | { mode: "help" }
  | { mode: "tools"; serverName?: string; showAll: boolean };

function formatMcpHelp(): string {
  return [
    "MCP command usage:",
    "  /mcp                    Show compact MCP status",
    "  /mcp help               Show this help",
    "  /mcp --help             Show this help",
    "  /mcp tools              Show registered tool names, limited per server",
    "  /mcp tools <server>     Show registered tool names for one server",
    "  /mcp tools --all        Show all registered tool names",
    "  /mcp tools <server> --all  Show all registered tool names for one server",
  ].join("\n");
}

function parseMcpCommandArgs(args: string): McpCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { mode: "status" };

  const [command, ...rest] = tokens;
  const normalized = command.toLowerCase();
  if (normalized === "help" || normalized === "--help" || normalized === "-h") return { mode: "help" };

  if (normalized === "tools") {
    const showAll = rest.includes("--all") || rest.includes("-a");
    const serverName = rest.find((token) => token !== "--all" && token !== "-a");
    return { mode: "tools", serverName, showAll };
  }

  return { mode: "help" };
}

function formatMcpStatus(configFile: string | undefined): string {
  const lines = [`MCP config: ${configFile ?? "none"}`];
  if (connected.size === 0) {
    lines.push("No MCP servers connected.");
  } else {
    lines.push(`Connected MCP servers: ${connected.size}`);
    for (const server of connected.values()) {
      lines.push(`- ${server.name}: ${server.toolNames.length} tool(s)`);
    }
  }
  lines.push("", "Run /mcp help for options.");
  return lines.join("\n");
}

function formatMcpTools(configFile: string | undefined, serverName: string | undefined, showAll: boolean): { text: string; level: NotifyLevel } {
  const lines = [`MCP config: ${configFile ?? "none"}`];

  if (connected.size === 0) {
    lines.push("No MCP servers connected.");
    return { text: lines.join("\n"), level: "warning" };
  }

  const servers = serverName ? [connected.get(serverName)].filter((server): server is ConnectedServer => Boolean(server)) : [...connected.values()];
  if (serverName && servers.length === 0) {
    lines.push(`MCP server not connected: ${serverName}`);
    lines.push(`Available servers: ${[...connected.keys()].join(", ")}`);
    return { text: lines.join("\n"), level: "warning" };
  }

  for (const server of servers) {
    lines.push(`- ${server.name}: ${server.toolNames.length} tool(s)`);
    const visibleToolNames = showAll ? server.toolNames : server.toolNames.slice(0, DEFAULT_TOOL_LIST_LIMIT);
    for (const toolName of visibleToolNames) lines.push(`  - ${toolName}`);
    if (server.toolNames.length === 0) lines.push("  (no tools registered)");

    const remaining = server.toolNames.length - visibleToolNames.length;
    if (remaining > 0) {
      lines.push(`  ... ${remaining} more. Run /mcp tools ${server.name} --all to show all for this server.`);
    }
  }

  if (!showAll) lines.push("", "Run /mcp tools --all to show every registered tool.");
  return { text: lines.join("\n"), level: "info" };
}

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const { path, config } = await loadConfig(cwd);
  const servers = config.servers ?? {};

  for (const [name, serverConfig] of Object.entries(servers)) {
    if (serverConfig.disabled) continue;
    try {
      const server = await connectServer(name, serverConfig, cwd);
      connected.set(name, server);
      await registerMcpServerTools(pi, server);
    } catch (error) {
      console.error(`[mcp] failed to connect ${name}:`, error);
    }
  }

  pi.registerCommand("mcp", {
    description: "Show MCP status; use /mcp help for options",
    handler: async (args, ctx) => {
      const parsed = parseMcpCommandArgs(args);

      if (parsed.mode === "help") {
        ctx.ui.notify(formatMcpHelp(), "info");
        return;
      }

      if (parsed.mode === "status") {
        ctx.ui.notify(formatMcpStatus(path), connected.size === 0 ? "warning" : "info");
        return;
      }

      const result = formatMcpTools(path, parsed.serverName, parsed.showAll);
      ctx.ui.notify(result.text, result.level);
    },
  });

  pi.registerTool({
    name: "mcp_status",
    label: "MCP Status",
    description: "List connected MCP servers and the pi tool names registered for their MCP tools.",
    promptSnippet: "List available MCP servers and tools",
    parameters: Type.Object({}),
    async execute() {
      const data = [...connected.values()].map((server) => ({
        name: server.name,
        tools: server.toolNames,
      }));
      return {
        content: [{ type: "text", text: data.length ? JSON.stringify(data, null, 2) : "No MCP servers connected." }],
        details: { servers: data },
      };
    },
  });

  pi.registerTool({
    name: "mcp_read_resource",
    label: "MCP Read Resource",
    description: "Read an MCP resource from a connected MCP server by URI.",
    promptSnippet: "Read a resource from a connected MCP server",
    parameters: Type.Object({
      server: StringEnum(connected.size ? ([...connected.keys()] as [string, ...string[]]) : ["none"]),
      uri: Type.String({ description: "MCP resource URI" }),
    }),
    async execute(_toolCallId, params) {
      const server = connected.get(params.server);
      if (!server) throw new Error(`MCP server not connected: ${params.server}`);
      const result = await server.client.readResource({ uri: params.uri });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { server: params.server, uri: params.uri, raw: result },
      };
    },
  });

  pi.registerTool({
    name: "mcp_list_resources",
    label: "MCP List Resources",
    description: "List resources exposed by a connected MCP server.",
    promptSnippet: "List resources from a connected MCP server",
    parameters: Type.Object({
      server: StringEnum(connected.size ? ([...connected.keys()] as [string, ...string[]]) : ["none"]),
    }),
    async execute(_toolCallId, params) {
      const server = connected.get(params.server);
      if (!server) throw new Error(`MCP server not connected: ${params.server}`);
      const result = await server.client.listResources();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { server: params.server, raw: result },
      };
    },
  });

  pi.registerTool({
    name: "mcp_list_prompts",
    label: "MCP List Prompts",
    description: "List prompts exposed by a connected MCP server.",
    promptSnippet: "List prompts from a connected MCP server",
    parameters: Type.Object({
      server: StringEnum(connected.size ? ([...connected.keys()] as [string, ...string[]]) : ["none"]),
    }),
    async execute(_toolCallId, params) {
      const server = connected.get(params.server);
      if (!server) throw new Error(`MCP server not connected: ${params.server}`);
      const result = await server.client.listPrompts();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { server: params.server, raw: result },
      };
    },
  });

  pi.registerTool({
    name: "mcp_get_prompt",
    label: "MCP Get Prompt",
    description: "Get/render a prompt from a connected MCP server.",
    promptSnippet: "Get a prompt from a connected MCP server",
    parameters: Type.Object({
      server: StringEnum(connected.size ? ([...connected.keys()] as [string, ...string[]]) : ["none"]),
      name: Type.String({ description: "MCP prompt name" }),
      arguments: Type.Optional(Type.Any({ description: "Prompt arguments object" })),
    }),
    async execute(_toolCallId, params) {
      const server = connected.get(params.server);
      if (!server) throw new Error(`MCP server not connected: ${params.server}`);
      const result = await server.client.getPrompt({
        name: params.name,
        arguments: (params.arguments ?? {}) as Record<string, string>,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { server: params.server, name: params.name, raw: result },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([...connected.values()].map((server) => server.client.close()));
    connected.clear();
    registeredToolNames.clear();
  });
}
