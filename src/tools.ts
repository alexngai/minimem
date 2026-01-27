/**
 * Tool definitions for memory operations
 *
 * These tools are compatible with:
 * - MCP (Model Context Protocol)
 * - Anthropic Claude tool use
 * - OpenAI function calling
 */

import type { Minimem, MinimemSearchResult } from "./minimem.js";

/**
 * JSON Schema for tool parameters (MCP/OpenAI/Anthropic compatible)
 */
export type ToolInputSchema = {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    items?: { type: string };
    default?: unknown;
  }>;
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

/**
 * Memory get tool parameters
 */
export type MemoryGetParams = {
  path: string;
  from?: number;
  lines?: number;
};

/**
 * Memory write tool parameters
 */
export type MemoryWriteParams = {
  path: string;
  content: string;
};

/**
 * Memory append tool parameters
 */
export type MemoryAppendParams = {
  path: string;
  content: string;
};

/**
 * Memory log tool parameters (append to today's log)
 */
export type MemoryLogParams = {
  content: string;
};

/**
 * Memory list tool parameters
 */
export type MemoryListParams = Record<string, never>;

// Tool definitions

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

export const MEMORY_GET_TOOL: ToolDefinition = {
  name: "memory_get",
  description:
    "Read content from a memory file with optional line range. " +
    "Use after memory_search to retrieve specific content. " +
    "Paths must be MEMORY.md or memory/*.md.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to memory file (e.g., 'memory/2024-01-15.md' or 'MEMORY.md')",
      },
      from: {
        type: "number",
        description: "Starting line number (1-indexed, default: 1)",
      },
      lines: {
        type: "number",
        description: "Number of lines to read (default: entire file)",
      },
    },
    required: ["path"],
  },
};

export const MEMORY_WRITE_TOOL: ToolDefinition = {
  name: "memory_write",
  description:
    "Write or overwrite a memory file. Use for storing curated long-term memory. " +
    "Paths must be MEMORY.md or memory/*.md. Creates directories if needed.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to memory file (e.g., 'memory/project-notes.md' or 'MEMORY.md')",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

export const MEMORY_APPEND_TOOL: ToolDefinition = {
  name: "memory_append",
  description:
    "Append content to a memory file. Creates the file if it doesn't exist. " +
    "Paths must be MEMORY.md or memory/*.md. Good for adding notes incrementally.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to memory file (e.g., 'memory/2024-01-15.md')",
      },
      content: {
        type: "string",
        description: "Content to append to the file",
      },
    },
    required: ["path", "content"],
  },
};

export const MEMORY_LOG_TOOL: ToolDefinition = {
  name: "memory_log",
  description:
    "Append a note to today's daily log (memory/YYYY-MM-DD.md). " +
    "Convenience tool for quick timestamped notes. Creates the file if needed.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Content to append to today's log",
      },
    },
    required: ["content"],
  },
};

export const MEMORY_LIST_TOOL: ToolDefinition = {
  name: "memory_list",
  description:
    "List all memory files (MEMORY.md and files in memory/ directory). " +
    "Returns relative paths to all indexed memory files.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

/**
 * All available memory tools
 */
export const MEMORY_TOOLS: ToolDefinition[] = [
  MEMORY_SEARCH_TOOL,
  MEMORY_GET_TOOL,
  MEMORY_WRITE_TOOL,
  MEMORY_APPEND_TOOL,
  MEMORY_LOG_TOOL,
  MEMORY_LIST_TOOL,
];

/**
 * Get tool definitions for use with LLM APIs
 */
export function getToolDefinitions(): ToolDefinition[] {
  return MEMORY_TOOLS;
}

/**
 * Tool executor that handles all memory operations
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
        case "memory_get":
          return await this.memoryGet(params as MemoryGetParams);
        case "memory_write":
          return await this.memoryWrite(params as MemoryWriteParams);
        case "memory_append":
          return await this.memoryAppend(params as MemoryAppendParams);
        case "memory_log":
          return await this.memoryLog(params as MemoryLogParams);
        case "memory_list":
          return await this.memoryList();
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

  private async memoryGet(params: MemoryGetParams): Promise<ToolResult> {
    const result = await this.minimem.readLines(params.path, {
      from: params.from,
      lines: params.lines,
    });

    if (result === null) {
      return {
        content: [{ type: "text", text: `File not found: ${params.path}` }],
        isError: true,
      };
    }

    const header = `# ${params.path} (lines ${result.startLine}-${result.endLine})\n\n`;
    return {
      content: [{ type: "text", text: header + result.content }],
    };
  }

  private async memoryWrite(params: MemoryWriteParams): Promise<ToolResult> {
    await this.minimem.writeFile(params.path, params.content);
    return {
      content: [{ type: "text", text: `Written to ${params.path}` }],
    };
  }

  private async memoryAppend(params: MemoryAppendParams): Promise<ToolResult> {
    await this.minimem.appendFile(params.path, params.content);
    return {
      content: [{ type: "text", text: `Appended to ${params.path}` }],
    };
  }

  private async memoryLog(params: MemoryLogParams): Promise<ToolResult> {
    const filePath = await this.minimem.appendToday(params.content);
    return {
      content: [{ type: "text", text: `Logged to ${filePath}` }],
    };
  }

  private async memoryList(): Promise<ToolResult> {
    const files = await this.minimem.listFiles();
    if (files.length === 0) {
      return {
        content: [{ type: "text", text: "No memory files found." }],
      };
    }
    return {
      content: [{ type: "text", text: files.join("\n") }],
    };
  }
}

/**
 * Create a tool executor for the given Minimem instance
 */
export function createToolExecutor(minimem: Minimem): MemoryToolExecutor {
  return new MemoryToolExecutor(minimem);
}
