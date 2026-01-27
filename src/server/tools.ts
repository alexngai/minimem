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

import type { Minimem, MinimemSearchResult } from "../minimem.js";

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
  directories?: string[];
};

/**
 * Search result with source directory
 */
type SearchResultWithSource = MinimemSearchResult & {
  memoryDir: string;
};

export const MEMORY_SEARCH_TOOL: ToolDefinition = {
  name: "memory_search",
  description:
    "Semantically search through memory files (MEMORY.md and memory/*.md). " +
    "Use this to recall prior decisions, facts, preferences, people, dates, or context. " +
    "Returns ranked snippets with file paths and line numbers. " +
    "When multiple memory directories are configured, searches all by default.",
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
      directories: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional: filter to specific memory directories by name/path. " +
          "If omitted, searches all configured directories.",
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
 * Memory instance with its directory path
 */
export type MemoryInstance = {
  minimem: Minimem;
  memoryDir: string;
  name?: string;
};

/**
 * Tool executor that handles memory search across multiple directories
 */
export class MemoryToolExecutor {
  private instances: MemoryInstance[];

  constructor(instances: Minimem | MemoryInstance | MemoryInstance[]) {
    // Normalize to array of MemoryInstance
    if (Array.isArray(instances)) {
      this.instances = instances;
    } else if ("minimem" in instances) {
      this.instances = [instances];
    } else {
      // Legacy: single Minimem instance without directory info
      this.instances = [{ minimem: instances, memoryDir: "default" }];
    }
  }

  /**
   * Get list of configured directory names/paths
   */
  getDirectories(): string[] {
    return this.instances.map((i) => i.name ?? i.memoryDir);
  }

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
    const maxResults = params.maxResults ?? 10;
    const minScore = params.minScore;

    // Filter instances by directories param if provided
    let instancesToSearch = this.instances;
    if (params.directories && params.directories.length > 0) {
      const dirFilter = new Set(params.directories.map((d) => d.toLowerCase()));
      instancesToSearch = this.instances.filter((i) => {
        const name = (i.name ?? i.memoryDir).toLowerCase();
        const dir = i.memoryDir.toLowerCase();
        return (
          dirFilter.has(name) ||
          dirFilter.has(dir) ||
          // Also match partial paths
          [...dirFilter].some((f) => dir.includes(f) || name.includes(f))
        );
      });

      if (instancesToSearch.length === 0) {
        const available = this.getDirectories().join(", ");
        return {
          content: [
            {
              type: "text",
              text: `No matching directories found. Available: ${available}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Search all matching instances
    const allResults: SearchResultWithSource[] = [];

    for (const instance of instancesToSearch) {
      // Get more results per directory, then merge and trim
      const perDirMax = Math.ceil(maxResults * 1.5);
      const results = await instance.minimem.search(params.query, {
        maxResults: perDirMax,
        minScore,
      });

      for (const result of results) {
        allResults.push({
          ...result,
          memoryDir: instance.name ?? instance.memoryDir,
        });
      }
    }

    // Sort by score and limit
    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, maxResults);

    if (topResults.length === 0) {
      return {
        content: [{ type: "text", text: "No results found." }],
      };
    }

    // Format results
    const showSource = instancesToSearch.length > 1;
    const formatted = topResults
      .map((r, i) => {
        const location = `${r.path}:${r.startLine}-${r.endLine}`;
        const score = (r.score * 100).toFixed(1);
        const source = showSource ? ` [${r.memoryDir}]` : "";
        return `[${i + 1}] ${location}${source} (${score}% match)\n${r.snippet}`;
      })
      .join("\n\n");

    const dirSummary =
      instancesToSearch.length > 1
        ? `\n\n(Searched ${instancesToSearch.length} directories)`
        : "";

    return {
      content: [{ type: "text", text: formatted + dirSummary }],
    };
  }
}

/**
 * Create a tool executor for the given Minimem instance(s)
 */
export function createToolExecutor(
  instances: Minimem | MemoryInstance | MemoryInstance[],
): MemoryToolExecutor {
  return new MemoryToolExecutor(instances);
}
