import { describe, expect, it, vi } from "vitest";

import {
  getToolDefinitions,
  MEMORY_TOOLS,
  MEMORY_SEARCH_TOOL,
  MEMORY_GET_DETAILS_TOOL,
  MemoryToolExecutor,
  type ToolDefinition,
  type MemoryInstance,
} from "../tools.js";
import type { Minimem } from "../../minimem.js";

describe("Tool definitions", () => {
  it("exports memory_search and memory_get_details tools", () => {
    expect(MEMORY_TOOLS).toHaveLength(5);
    expect(MEMORY_TOOLS.map((t) => t.name)).toEqual([
      "memory_search",
      "memory_get_details",
      "knowledge_search",
      "knowledge_graph",
      "knowledge_path",
    ]);
  });

  it("getToolDefinitions returns all tools", () => {
    const tools = getToolDefinitions();
    expect(tools).toEqual(MEMORY_TOOLS);
  });
});

describe("memory_search tool", () => {
  it("has correct schema", () => {
    expect(MEMORY_SEARCH_TOOL.name).toBe("memory_search");
    expect(MEMORY_SEARCH_TOOL.inputSchema.type).toBe("object");
    expect(MEMORY_SEARCH_TOOL.inputSchema.required).toContain("query");
    expect(MEMORY_SEARCH_TOOL.inputSchema.properties.query.type).toBe("string");
    expect(MEMORY_SEARCH_TOOL.inputSchema.properties.maxResults.type).toBe("number");
    expect(MEMORY_SEARCH_TOOL.inputSchema.properties.minScore.type).toBe("number");
  });

  it("has detail parameter with compact and full options", () => {
    const detail = MEMORY_SEARCH_TOOL.inputSchema.properties.detail;
    expect(detail.type).toBe("string");
    expect(detail.enum).toEqual(["compact", "full"]);
  });

  it("has description", () => {
    expect(MEMORY_SEARCH_TOOL.description).toBeTruthy();
    expect(MEMORY_SEARCH_TOOL.description.length).toBeGreaterThan(20);
  });
});

describe("memory_get_details tool", () => {
  it("has correct schema", () => {
    expect(MEMORY_GET_DETAILS_TOOL.name).toBe("memory_get_details");
    expect(MEMORY_GET_DETAILS_TOOL.inputSchema.type).toBe("object");
    expect(MEMORY_GET_DETAILS_TOOL.inputSchema.required).toContain("results");
    expect(MEMORY_GET_DETAILS_TOOL.inputSchema.properties.results.type).toBe("array");
  });

  it("has description mentioning two-step approach", () => {
    expect(MEMORY_GET_DETAILS_TOOL.description).toContain("two-step");
  });
});

describe("Tool schema compatibility", () => {
  const validateToolSchema = (tool: ToolDefinition) => {
    // MCP/OpenAI/Anthropic require type: "object" at top level
    expect(tool.inputSchema.type).toBe("object");

    // All tools need name and description
    expect(tool.name).toBeTruthy();
    expect(tool.description).toBeTruthy();

    // Properties should be an object
    expect(typeof tool.inputSchema.properties).toBe("object");

    // Required should be an array (or undefined)
    if (tool.inputSchema.required !== undefined) {
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  };

  it("all tools have valid schemas", () => {
    for (const tool of MEMORY_TOOLS) {
      validateToolSchema(tool);
    }
  });

  it("tool names are snake_case", () => {
    for (const tool of MEMORY_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("property types are valid JSON Schema types", () => {
    const validTypes = ["string", "number", "boolean", "array", "object", "null"];
    for (const tool of MEMORY_TOOLS) {
      for (const prop of Object.values(tool.inputSchema.properties)) {
        expect(validTypes).toContain(prop.type);
      }
    }
  });
});

describe("memory_search tool schema", () => {
  it("has type parameter for observation filtering", () => {
    const type = MEMORY_SEARCH_TOOL.inputSchema.properties.type;
    expect(type).toBeDefined();
    expect(type.type).toBe("string");
    expect(type.description).toContain("type");
  });

  it("has directories parameter", () => {
    const dirs = MEMORY_SEARCH_TOOL.inputSchema.properties.directories;
    expect(dirs).toBeDefined();
    expect(dirs.type).toBe("array");
  });
});

// Helper to create mock Minimem for executor tests
function createMockMinimem(searchResults: Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}> = []) {
  return {
    search: vi.fn().mockResolvedValue(searchResults),
    readLines: vi.fn().mockImplementation((path: string, opts?: { from?: number; lines?: number }) => {
      // Simulate returning content for known paths
      if (path === "memory/test.md") {
        return Promise.resolve({
          content: "Full content of test.md\nLine 2\nLine 3",
          startLine: opts?.from ?? 1,
          endLine: (opts?.from ?? 1) + (opts?.lines ?? 3) - 1,
        });
      }
      return Promise.resolve(null);
    }),
  } as unknown as Minimem;
}

describe("MemoryToolExecutor", () => {
  describe("memorySearch with type filter", () => {
    it("passes type parameter to search", async () => {
      const mock = createMockMinimem([
        { path: "memory/test.md", startLine: 1, endLine: 5, score: 0.85, snippet: "Decision about API" },
      ]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      await executor.execute("memory_search", {
        query: "API design",
        type: "decision",
      });

      expect(mock.search).toHaveBeenCalledWith("API design", {
        maxResults: 15,
        minScore: undefined,
        type: "decision",
      });
    });

    it("does not pass type when not specified", async () => {
      const mock = createMockMinimem([]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      await executor.execute("memory_search", { query: "test" });

      expect(mock.search).toHaveBeenCalledWith("test", {
        maxResults: 15,
        minScore: undefined,
        type: undefined,
      });
    });
  });

  describe("memorySearch compact format", () => {
    it("returns compact format by default with preview and hint", async () => {
      const mock = createMockMinimem([
        { path: "memory/test.md", startLine: 1, endLine: 5, score: 0.9, snippet: "# Architecture Decision\nWe chose TypeScript." },
      ]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_search", { query: "architecture" });

      const text = result.content[0].text;
      // Compact: uses [0] indexing, percentage without decimal, short preview
      expect(text).toContain("[0]");
      expect(text).toContain("90%");
      expect(text).toContain("memory/test.md:1-5");
      // Should show a heading-based preview
      expect(text).toContain("Architecture Decision");
      // Should include hint
      expect(text).toContain("memory_get_details");
    });

    it("truncates long previews to ~80 chars with ellipsis", async () => {
      const longSnippet = "A".repeat(120);
      const mock = createMockMinimem([
        { path: "test.md", startLine: 1, endLine: 1, score: 0.8, snippet: longSnippet },
      ]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_search", { query: "test" });

      const text = result.content[0].text;
      // Preview should be truncated — the line with the preview should be ~80 chars + prefix
      const previewMatch = text.match(/"([^"]+)"/);
      expect(previewMatch).toBeTruthy();
      expect(previewMatch![1].length).toBeLessThanOrEqual(80);
      expect(previewMatch![1]).toContain("...");
    });

    it("shows (empty) for empty snippet", async () => {
      const mock = createMockMinimem([
        { path: "test.md", startLine: 1, endLine: 1, score: 0.5, snippet: "" },
      ]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_search", { query: "test" });
      expect(result.content[0].text).toContain("(empty)");
    });

    it("returns no results message when empty", async () => {
      const mock = createMockMinimem([]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_search", { query: "nonexistent" });
      expect(result.content[0].text).toBe("No results found.");
    });
  });

  describe("memorySearch full format", () => {
    it("returns full snippets when detail=full", async () => {
      const mock = createMockMinimem([
        { path: "test.md", startLine: 1, endLine: 5, score: 0.85, snippet: "Full detailed content here\nWith multiple lines" },
      ]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_search", { query: "test", detail: "full" });

      const text = result.content[0].text;
      expect(text).toContain("Full detailed content here");
      expect(text).toContain("With multiple lines");
      // Full mode uses [1] indexing and .1 decimal precision
      expect(text).toContain("[1]");
      expect(text).toContain("85.0%");
      // No hint about memory_get_details
      expect(text).not.toContain("Use memory_get_details");
    });
  });

  describe("memorySearch multi-directory", () => {
    it("shows directory source when searching multiple dirs", async () => {
      const mock1 = createMockMinimem([
        { path: "MEMORY.md", startLine: 1, endLine: 3, score: 0.9, snippet: "From project A" },
      ]);
      const mock2 = createMockMinimem([
        { path: "MEMORY.md", startLine: 1, endLine: 3, score: 0.8, snippet: "From project B" },
      ]);
      const executor = new MemoryToolExecutor([
        { minimem: mock1, memoryDir: "/projectA", name: "projectA" },
        { minimem: mock2, memoryDir: "/projectB", name: "projectB" },
      ]);

      const result = await executor.execute("memory_search", { query: "test", detail: "full" });
      const text = result.content[0].text;
      expect(text).toContain("[projectA]");
      expect(text).toContain("[projectB]");
      expect(text).toContain("Searched 2 directories");
    });

    it("returns error when directory filter matches nothing", async () => {
      const mock = createMockMinimem([]);
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test", name: "test" });

      const result = await executor.execute("memory_search", {
        query: "test",
        directories: ["nonexistent"],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No matching directories");
    });
  });

  describe("memoryGetDetails", () => {
    it("returns full text for requested chunks", async () => {
      const mock = createMockMinimem();
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_get_details", {
        results: [{ path: "memory/test.md", startLine: 1, endLine: 3 }],
      });

      expect(mock.readLines).toHaveBeenCalledWith("memory/test.md", { from: 1, lines: 3 });
      const text = result.content[0].text;
      expect(text).toContain("memory/test.md:1-3");
      expect(text).toContain("Full content of test.md");
    });

    it("returns (not found) for non-existent files", async () => {
      const mock = createMockMinimem();
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_get_details", {
        results: [{ path: "memory/nonexistent.md", startLine: 1, endLine: 5 }],
      });

      const text = result.content[0].text;
      expect(text).toContain("(not found)");
      expect(text).toContain("memory/nonexistent.md:1-5");
    });

    it("handles multiple results with mixed found/not-found", async () => {
      const mock = createMockMinimem();
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_get_details", {
        results: [
          { path: "memory/test.md", startLine: 1, endLine: 3 },
          { path: "memory/missing.md", startLine: 1, endLine: 5 },
        ],
      });

      const text = result.content[0].text;
      expect(text).toContain("Full content of test.md");
      expect(text).toContain("(not found)");
    });

    it("returns error for empty results array", async () => {
      const mock = createMockMinimem();
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("memory_get_details", { results: [] });
      expect(result.isError).toBe(true);
    });

    it("returns error when directory filter matches nothing", async () => {
      const mock = createMockMinimem();
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test", name: "test" });

      const result = await executor.execute("memory_get_details", {
        results: [{ path: "test.md", startLine: 1, endLine: 1 }],
        directories: ["nonexistent"],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No matching directories");
    });
  });

  describe("unknown tools", () => {
    it("returns error for unknown tool name", async () => {
      const mock = createMockMinimem();
      const executor = new MemoryToolExecutor({ minimem: mock, memoryDir: "/test" });

      const result = await executor.execute("nonexistent_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
