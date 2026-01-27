import { describe, expect, it, vi, beforeEach } from "vitest";

import { McpServer, createMcpServer, generateMcpConfig } from "../mcp.js";
import type { Minimem } from "../../minimem.js";

// Mock Minimem instance
const createMockMinimem = () => {
  return {
    search: vi.fn().mockResolvedValue([
      {
        path: "memory/test.md",
        startLine: 1,
        endLine: 5,
        score: 0.85,
        snippet: "Test content",
      },
    ]),
  } as unknown as Minimem;
};

describe("McpServer", () => {
  let server: McpServer;
  let mockMinimem: ReturnType<typeof createMockMinimem>;

  beforeEach(() => {
    mockMinimem = createMockMinimem();
    server = createMcpServer(mockMinimem as Minimem);
  });

  describe("initialize", () => {
    it("responds with protocol version and capabilities", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "minimem",
          version: expect.any(String),
        },
      });
    });
  });

  describe("tools/list", () => {
    it("returns memory_search tool", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(1);
      expect(result.tools.map((t) => t.name)).toEqual(["memory_search"]);
    });

    it("tools have valid schemas", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      });

      const result = response.result as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: { type: string };
        }>;
      };

      for (const tool of result.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  describe("tools/call", () => {
    it("calls memory_search tool", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "test query" },
        },
      });

      expect(response.error).toBeUndefined();
      // Multi-directory search fetches ceil(maxResults * 1.5) per directory
      expect(mockMinimem.search).toHaveBeenCalledWith("test query", {
        maxResults: 15, // ceil(10 * 1.5)
        minScore: undefined,
      });

      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("memory/test.md");
    });

    it("returns error for unknown tool", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("returns error when tool name missing", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { arguments: {} },
      });

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain("Missing tool name");
    });
  });

  describe("error handling", () => {
    it("returns method not found for unknown methods", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "unknown/method",
      });

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toContain("Method not found");
    });

    it("handles ping method", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "ping",
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({});
    });
  });
});

describe("generateMcpConfig", () => {
  it("generates valid config for Claude Desktop", () => {
    const config = generateMcpConfig({
      serverPath: "/path/to/server.js",
      memoryDir: "/home/user/memory",
    });

    expect(config.command).toBe("node");
    expect(config.args).toEqual(["/path/to/server.js"]);
    expect(config.env?.MEMORY_DIR).toBe("/home/user/memory");
  });

  it("includes embedding provider when specified", () => {
    const config = generateMcpConfig({
      serverPath: "/path/to/server.js",
      memoryDir: "/home/user/memory",
      embeddingProvider: "openai",
    });

    expect(config.env?.EMBEDDING_PROVIDER).toBe("openai");
  });
});
