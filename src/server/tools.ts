/**
 * Tool definitions for memory operations
 *
 * These tools are compatible with:
 * - MCP (Model Context Protocol)
 * - Anthropic Claude tool use
 * - OpenAI function calling
 *
 * Note: Only memory_search is provided since the memory system is file-based.
 * Agents can use filesystem tools directly for read/write operations.
 */

import type { Minimem } from "../minimem.js";

/**
 * JSON Schema for tool parameters (MCP/OpenAI/Anthropic compatible)
 */
export type ToolInputSchema = {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      enum?: string[];
      items?: { type: string };
      default?: unknown;
    }
  >;
  required?: string[];
};

/**
 * Tool definition compatible with MCP, Anthropic, and OpenAI
 */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
};

/**
 * Tool execution result
 */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Memory search tool parameters
 */
export type MemorySearchParams = {
  query: string;
  maxResults?: number;
  minScore?: number;
};

export const MEMORY_SEARCH_TOOL: ToolDefinition = {
  name: "memory_search",
  description:
    "Semantically search through memory files (MEMORY.md and memory/*.md). " +
    "Use this to recall prior decisions, facts, preferences, people, dates, or context. " +
    "Returns ranked snippets with file paths and line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language search query",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default: 10)",
      },
      minScore: {
        type: "number",
        description: "Minimum relevance score threshold 0-1 (default: 0.3)",
      },
    },
    required: ["query"],
  },
};

/**
 * All available memory tools
 */
export const MEMORY_TOOLS: ToolDefinition[] = [MEMORY_SEARCH_TOOL];

/**
 * Get tool definitions for use with LLM APIs
 */
export function getToolDefinitions(): ToolDefinition[] {
  return MEMORY_TOOLS;
}

/**
 * Tool executor that handles memory search
 */
export class MemoryToolExecutor {
  constructor(private minimem: Minimem) {}

  /**
   * Execute a tool by name with given parameters
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      switch (toolName) {
        case "memory_search":
          return await this.memorySearch(params as MemorySearchParams);
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  private async memorySearch(params: MemorySearchParams): Promise<ToolResult> {
    const results = await this.minimem.search(params.query, {
      maxResults: params.maxResults,
      minScore: params.minScore,
    });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No results found." }],
      };
    }

    const formatted = results
      .map((r, i) => {
        const location = `${r.path}:${r.startLine}-${r.endLine}`;
        const score = (r.score * 100).toFixed(1);
        return `[${i + 1}] ${location} (${score}% match)\n${r.snippet}`;
      })
      .join("\n\n");

    return {
      content: [{ type: "text", text: formatted }],
    };
  }
}

/**
 * Create a tool executor for the given Minimem instance
 */
export function createToolExecutor(minimem: Minimem): MemoryToolExecutor {
  return new MemoryToolExecutor(minimem);
}
