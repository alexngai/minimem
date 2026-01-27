/**
 * MCP (Model Context Protocol) Server for Minimem
 *
 * Provides memory tools via JSON-RPC 2.0 over stdio.
 * Compatible with Claude Desktop, Cursor, and other MCP clients.
 *
 * Usage:
 *   import { Minimem } from "minimem";
 *   import { createMcpServer, runMcpServer } from "minimem/mcp";
 *
 *   const minimem = await Minimem.create({ ... });
 *   const server = createMcpServer(minimem);
 *   await runMcpServer(server);  // Runs over stdio
 */

import * as readline from "node:readline";
import type { Minimem } from "../minimem.js";
import {
  MEMORY_TOOLS,
  type ToolDefinition,
  type ToolResult,
  MemoryToolExecutor,
} from "./tools.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "minimem";
const SERVER_VERSION = "0.1.0";

/**
 * JSON-RPC 2.0 request
 */
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

/**
 * JSON-RPC 2.0 response
 */
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

/**
 * JSON-RPC 2.0 notification (no id)
 */
type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

/**
 * MCP Server capabilities
 */
type ServerCapabilities = {
  tools?: {
    listChanged?: boolean;
  };
};

/**
 * MCP Server info
 */
type ServerInfo = {
  name: string;
  version: string;
};

/**
 * MCP Initialize result
 */
type InitializeResult = {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
};

/**
 * MCP Tool in list format
 */
type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

/**
 * MCP Server implementation
 */
export class McpServer {
  private executor: MemoryToolExecutor;
  private initialized = false;

  constructor(private minimem: Minimem) {
    this.executor = new MemoryToolExecutor(minimem);
  }

  /**
   * Handle a JSON-RPC request and return a response
   */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const result = await this.dispatch(request.method, request.params);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof McpError ? err.code : -32603;
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code, message },
      };
    }
  }

  /**
   * Dispatch a method call
   */
  private async dispatch(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "initialized":
        // Notification, no response needed
        return {};
      case "tools/list":
        return this.listTools();
      case "tools/call":
        return this.callTool(params);
      case "ping":
        return {};
      default:
        throw new McpError(-32601, `Method not found: ${method}`);
    }
  }

  /**
   * Handle initialize request
   */
  private initialize(
    params?: Record<string, unknown>,
  ): InitializeResult {
    this.initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    };
  }

  /**
   * List available tools
   */
  private listTools(): { tools: McpTool[] } {
    const tools: McpTool[] = MEMORY_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return { tools };
  }

  /**
   * Call a tool
   */
  private async callTool(
    params?: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (!params?.name || typeof params.name !== "string") {
      throw new McpError(-32602, "Missing tool name");
    }

    const toolName = params.name;
    const toolParams = (params.arguments ?? {}) as Record<string, unknown>;

    const result = await this.executor.execute(toolName, toolParams);
    return result;
  }
}

/**
 * Custom error class for MCP errors
 */
class McpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * Create an MCP server for the given Minimem instance
 */
export function createMcpServer(minimem: Minimem): McpServer {
  return new McpServer(minimem);
}

/**
 * Run the MCP server over stdio
 */
export async function runMcpServer(server: McpServer): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const send = (message: JsonRpcResponse | JsonRpcNotification) => {
    const json = JSON.stringify(message);
    process.stdout.write(json + "\n");
  };

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    try {
      const request = JSON.parse(line) as JsonRpcRequest;

      if (request.jsonrpc !== "2.0") {
        send({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32600, message: "Invalid JSON-RPC version" },
        });
        return;
      }

      // Handle notification (no id)
      if (request.id === undefined) {
        await server.handleRequest({ ...request, id: 0 });
        return;
      }

      const response = await server.handleRequest(request);
      send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${message}` },
      });
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}

/**
 * MCP server configuration for claude_desktop_config.json
 *
 * Example:
 * {
 *   "mcpServers": {
 *     "minimem": {
 *       "command": "node",
 *       "args": ["path/to/your/mcp-server.js"],
 *       "env": {
 *         "MEMORY_DIR": "/path/to/memory"
 *       }
 *     }
 *   }
 * }
 */
export type McpServerConfig = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/**
 * Generate MCP server config for Claude Desktop
 */
export function generateMcpConfig(opts: {
  serverPath: string;
  memoryDir: string;
  embeddingProvider?: "openai" | "gemini" | "local" | "auto";
}): McpServerConfig {
  return {
    command: "node",
    args: [opts.serverPath],
    env: {
      MEMORY_DIR: opts.memoryDir,
      ...(opts.embeddingProvider ? { EMBEDDING_PROVIDER: opts.embeddingProvider } : {}),
    },
  };
}
