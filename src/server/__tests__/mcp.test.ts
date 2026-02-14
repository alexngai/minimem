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
        snippet: "Test content about architecture decisions",
      },
    ]),
    readLines: vi.fn().mockResolvedValue({
      content: "Full test content about architecture decisions\nLine 2\nLine 3\nLine 4\nLine 5",
      startLine: 1,
      endLine: 5,
    }),
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
    it("returns memory_search and memory_get_details tools", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(2);
      expect(result.tools.map((t) => t.name)).toEqual(["memory_search", "memory_get_details"]);
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
    it("calls memory_search with compact detail by default", async () => {
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
      expect(mockMinimem.search).toHaveBeenCalledWith("test query", {
        maxResults: 15,
        minScore: undefined,
        type: undefined,
      });

      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("memory/test.md");
      // Compact format: includes hint to use memory_get_details
      expect(result.content[0].text).toContain("memory_get_details");
      // Compact format: short preview, not full snippet
      expect(result.content[0].text).toContain("85%");
    });

    it("calls memory_search with full detail", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: "full-1",
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "test query", detail: "full" },
        },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      // Full format: contains the full snippet text
      expect(result.content[0].text).toContain("Test content about architecture decisions");
      // Full format: does NOT contain the compact hint
      expect(result.content[0].text).not.toContain("Use memory_get_details");
    });

    it("calls memory_get_details tool", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: "details-1",
        method: "tools/call",
        params: {
          name: "memory_get_details",
          arguments: {
            results: [{ path: "memory/test.md", startLine: 1, endLine: 5 }],
          },
        },
      });

      expect(response.error).toBeUndefined();
      expect(mockMinimem.readLines).toHaveBeenCalledWith("memory/test.md", {
        from: 1,
        lines: 5,
      });

      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].text).toContain("Full test content about architecture decisions");
      expect(result.content[0].text).toContain("memory/test.md:1-5");
    });

    it("memory_get_details returns error for empty results", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: "details-2",
        method: "tools/call",
        params: {
          name: "memory_get_details",
          arguments: { results: [] },
        },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
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

    it("passes type filter via MCP to search", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: "type-1",
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "API design", type: "decision" },
        },
      });

      expect(response.error).toBeUndefined();
      expect(mockMinimem.search).toHaveBeenCalledWith("API design", {
        maxResults: 15,
        minScore: undefined,
        type: "decision",
      });
    });

    it("passes detail and type together", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: "combo-1",
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "bugs", detail: "full", type: "bugfix" },
        },
      });

      expect(response.error).toBeUndefined();
      expect(mockMinimem.search).toHaveBeenCalledWith("bugs", {
        maxResults: 15,
        minScore: undefined,
        type: "bugfix",
      });
      const result = response.result as { content: Array<{ text: string }> };
      // Full mode — should have the snippet, not the hint
      expect(result.content[0].text).toContain("Test content about architecture decisions");
      expect(result.content[0].text).not.toContain("Use memory_get_details");
    });

    it("memory_get_details handles file not found gracefully", async () => {
      // Override readLines to return null
      mockMinimem.readLines = vi.fn().mockResolvedValue(null);

      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: "details-notfound",
        method: "tools/call",
        params: {
          name: "memory_get_details",
          arguments: {
            results: [{ path: "memory/missing.md", startLine: 1, endLine: 5 }],
          },
        },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain("(not found)");
      expect(result.content[0].text).toContain("memory/missing.md:1-5");
    });

    it("memory_search returns no results message", async () => {
      mockMinimem.search = vi.fn().mockResolvedValue([]);

      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: "empty-1",
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "something that does not exist" },
        },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toBe("No results found.");
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
