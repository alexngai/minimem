import { describe, expect, it } from "vitest";

import {
  getToolDefinitions,
  MEMORY_TOOLS,
  MEMORY_SEARCH_TOOL,
  type ToolDefinition,
} from "./tools.js";

describe("Tool definitions", () => {
  it("exports memory_search tool", () => {
    expect(MEMORY_TOOLS).toHaveLength(1);
    expect(MEMORY_TOOLS.map((t) => t.name)).toEqual(["memory_search"]);
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

  it("has description", () => {
    expect(MEMORY_SEARCH_TOOL.description).toBeTruthy();
    expect(MEMORY_SEARCH_TOOL.description.length).toBeGreaterThan(20);
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
