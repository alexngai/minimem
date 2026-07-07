/**
 * Tool definitions for memory operations
 *
 * These tools are compatible with:
 * - MCP (Model Context Protocol)
 * - Anthropic Claude tool use
 * - OpenAI function calling
 *
 * Read tools only (search + retrieval + knowledge graph) — the memory system
 * is file-based, so agents use filesystem tools directly for write operations.
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
  /** "compact" returns lightweight index; "full" returns complete snippets (default: "compact") */
  detail?: "compact" | "full";
  /** Filter by observation type (e.g., "decision", "bugfix", "feature", "discovery") */
  type?: string;
};

/**
 * Memory get details tool parameters
 */
export type MemoryGetDetailsParams = {
  results: Array<{ path: string; startLine: number; endLine: number }>;
  directories?: string[];
};

/**
 * Knowledge search tool parameters
 */
export type KnowledgeSearchParams = {
  query: string;
  domain?: string[];
  entities?: string[];
  minConfidence?: number;
  knowledgeType?: string;
  maxResults?: number;
  minScore?: number;
  directories?: string[];
};

/**
 * Knowledge graph traversal parameters
 */
export type KnowledgeGraphParams = {
  nodeId: string;
  depth?: number;
  relation?: string;
  layer?: string;
  directories?: string[];
};

/**
 * Knowledge path parameters
 */
export type KnowledgePathParams = {
  fromId: string;
  toId: string;
  maxDepth?: number;
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
      detail: {
        type: "string",
        enum: ["compact", "full"],
        description:
          "Result detail level. 'compact' returns a lightweight index with short previews (~80 chars). " +
          "'full' returns complete snippets. Use 'compact' first, then memory_get_details for selected results. " +
          "(default: 'compact')",
      },
      type: {
        type: "string",
        description:
          "Filter by observation type. Matches <!-- type: X --> comments in memory entries. " +
          "Common types: decision, bugfix, feature, discovery, context, note.",
      },
    },
    required: ["query"],
  },
};

export const MEMORY_GET_DETAILS_TOOL: ToolDefinition = {
  name: "memory_get_details",
  description:
    "Fetch full text for specific memory chunks identified by path and line range. " +
    "Use after memory_search with compact results to get details for selected items only. " +
    "This two-step approach significantly reduces token usage.",
  inputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: { type: "object" },
        description:
          "Array of { path, startLine, endLine } objects from compact search results.",
      },
      directories: {
        type: "array",
        items: { type: "string" },
        description: "Optional: filter to specific memory directories.",
      },
    },
    required: ["results"],
  },
};

export const KNOWLEDGE_SEARCH_TOOL: ToolDefinition = {
  name: "knowledge_search",
  description:
    "Search memory with knowledge metadata filters. " +
    "Filter by domain, entities, confidence level, or knowledge type (observation, entity, domain-summary). " +
    "Combines semantic search with structured knowledge filtering.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language search query",
      },
      domain: {
        type: "array",
        items: { type: "string" },
        description: "Filter to entries in these knowledge domains",
      },
      entities: {
        type: "array",
        items: { type: "string" },
        description: "Filter to entries referencing these entities",
      },
      minConfidence: {
        type: "number",
        description: "Minimum confidence threshold (0-1)",
      },
      knowledgeType: {
        type: "string",
        description: "Filter by knowledge type: observation, entity, domain-summary",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results (default: 10)",
      },
      minScore: {
        type: "number",
        description: "Minimum relevance score 0-1 (default: 0.3)",
      },
      directories: {
        type: "array",
        items: { type: "string" },
        description: "Optional: filter to specific memory directories",
      },
    },
    required: ["query"],
  },
};

export const KNOWLEDGE_GRAPH_TOOL: ToolDefinition = {
  name: "knowledge_graph",
  description:
    "Traverse knowledge graph links from a note. " +
    "Returns neighbor nodes connected by typed relationships (e.g., relates-to, supports, contradicts). " +
    "Use depth parameter for multi-hop traversal.",
  inputSchema: {
    type: "object",
    properties: {
      nodeId: {
        type: "string",
        description: "The knowledge node ID to start traversal from",
      },
      depth: {
        type: "number",
        description: "Maximum traversal depth (default: 1, max: 3)",
        default: 1,
      },
      relation: {
        type: "string",
        description: "Optional: filter to specific relation type",
      },
      layer: {
        type: "string",
        description: "Optional: filter to specific graph layer",
      },
      directories: {
        type: "array",
        items: { type: "string" },
        description: "Optional: filter to specific memory directories",
      },
    },
    required: ["nodeId"],
  },
};

export const KNOWLEDGE_PATH_TOOL: ToolDefinition = {
  name: "knowledge_path",
  description:
    "Find the shortest path between two knowledge nodes in the graph. " +
    "Uses BFS traversal up to a configurable max depth. " +
    "Returns the sequence of links connecting the two nodes.",
  inputSchema: {
    type: "object",
    properties: {
      fromId: {
        type: "string",
        description: "Starting knowledge node ID",
      },
      toId: {
        type: "string",
        description: "Target knowledge node ID",
      },
      maxDepth: {
        type: "number",
        description: "Maximum path length (default: 3)",
        default: 3,
      },
      directories: {
        type: "array",
        items: { type: "string" },
        description: "Optional: filter to specific memory directories",
      },
    },
    required: ["fromId", "toId"],
  },
};

/**
 * All available memory tools
 */
export const MEMORY_TOOLS: ToolDefinition[] = [
  MEMORY_SEARCH_TOOL,
  MEMORY_GET_DETAILS_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_GRAPH_TOOL,
  KNOWLEDGE_PATH_TOOL,
];

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
        case "memory_get_details":
          return await this.memoryGetDetails(params as MemoryGetDetailsParams);
        case "knowledge_search":
          return await this.knowledgeSearch(params as KnowledgeSearchParams);
        case "knowledge_graph":
          return await this.knowledgeGraph(params as KnowledgeGraphParams);
        case "knowledge_path":
          return await this.knowledgePath(params as KnowledgePathParams);
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

  /**
   * Filter instances by directory names/paths
   */
  private filterInstances(directories?: string[]): MemoryInstance[] | null {
    if (!directories || directories.length === 0) return this.instances;

    const dirFilter = new Set(directories.map((d) => d.toLowerCase()));
    const filtered = this.instances.filter((i) => {
      const name = (i.name ?? i.memoryDir).toLowerCase();
      const dir = i.memoryDir.toLowerCase();
      return (
        dirFilter.has(name) ||
        dirFilter.has(dir) ||
        [...dirFilter].some((f) => dir.includes(f) || name.includes(f))
      );
    });

    return filtered.length > 0 ? filtered : null;
  }

  private async memorySearch(params: MemorySearchParams): Promise<ToolResult> {
    const maxResults = params.maxResults ?? 10;
    const minScore = params.minScore;
    const detail = params.detail ?? "compact";

    const instancesToSearch = this.filterInstances(params.directories);
    if (!instancesToSearch) {
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

    // Search all matching instances
    const allResults: SearchResultWithSource[] = [];

    for (const instance of instancesToSearch) {
      const perDirMax = Math.ceil(maxResults * 1.5);
      const results = await instance.minimem.search(params.query, {
        maxResults: perDirMax,
        minScore,
        type: params.type,
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

    const showSource = instancesToSearch.length > 1;

    if (detail === "compact") {
      return this.formatCompactResults(topResults, showSource, instancesToSearch.length);
    }

    return this.formatFullResults(topResults, showSource, instancesToSearch.length);
  }

  private formatCompactResults(
    results: SearchResultWithSource[],
    showSource: boolean,
    dirCount: number,
  ): ToolResult {
    const formatted = results
      .map((r, i) => {
        const location = `${r.path}:${r.startLine}-${r.endLine}`;
        const score = (r.score * 100).toFixed(0);
        const source = showSource ? ` [${r.memoryDir}]` : "";
        const preview = compactPreview(r.snippet);
        return `[${i}] ${location}${source} (${score}%) — ${preview}`;
      })
      .join("\n");

    const hint = "\n\nUse memory_get_details to fetch full text for selected results.";
    const dirSummary = dirCount > 1 ? `\n(Searched ${dirCount} directories)` : "";

    return {
      content: [{ type: "text", text: formatted + dirSummary + hint }],
    };
  }

  private formatFullResults(
    results: SearchResultWithSource[],
    showSource: boolean,
    dirCount: number,
  ): ToolResult {
    const formatted = results
      .map((r, i) => {
        const location = `${r.path}:${r.startLine}-${r.endLine}`;
        const score = (r.score * 100).toFixed(1);
        const source = showSource ? ` [${r.memoryDir}]` : "";
        return `[${i + 1}] ${location}${source} (${score}% match)\n${r.snippet}`;
      })
      .join("\n\n");

    const dirSummary =
      dirCount > 1 ? `\n\n(Searched ${dirCount} directories)` : "";

    return {
      content: [{ type: "text", text: formatted + dirSummary }],
    };
  }

  private async memoryGetDetails(params: MemoryGetDetailsParams): Promise<ToolResult> {
    if (!params.results || params.results.length === 0) {
      return {
        content: [{ type: "text", text: "No results specified." }],
        isError: true,
      };
    }

    const instancesToSearch = this.filterInstances(params.directories);
    if (!instancesToSearch) {
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

    const details: string[] = [];

    for (const ref of params.results) {
      let found = false;

      for (const instance of instancesToSearch) {
        const lineCount = ref.endLine - ref.startLine + 1;
        const result = await instance.minimem.readLines(ref.path, {
          from: ref.startLine,
          lines: lineCount,
        });

        if (result) {
          const location = `${ref.path}:${result.startLine}-${result.endLine}`;
          details.push(`--- ${location} ---\n${result.content}`);
          found = true;
          break;
        }
      }

      if (!found) {
        details.push(`--- ${ref.path}:${ref.startLine}-${ref.endLine} ---\n(not found)`);
      }
    }

    return {
      content: [{ type: "text", text: details.join("\n\n") }],
    };
  }

  private async knowledgeSearch(params: KnowledgeSearchParams): Promise<ToolResult> {
    const instancesToSearch = this.filterInstances(params.directories);
    if (!instancesToSearch) {
      const available = this.getDirectories().join(", ");
      return {
        content: [{ type: "text", text: `No matching directories found. Available: ${available}` }],
        isError: true,
      };
    }

    const maxResults = params.maxResults ?? 10;
    const allResults: SearchResultWithSource[] = [];

    for (const instance of instancesToSearch) {
      const results = await instance.minimem.knowledgeSearch(params.query, {
        maxResults: Math.ceil(maxResults * 1.5),
        minScore: params.minScore,
        domain: params.domain,
        entities: params.entities,
        minConfidence: params.minConfidence,
        knowledgeType: params.knowledgeType,
      });

      for (const result of results) {
        allResults.push({
          ...result,
          memoryDir: instance.name ?? instance.memoryDir,
        });
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, maxResults);

    if (topResults.length === 0) {
      return { content: [{ type: "text", text: "No knowledge results found." }] };
    }

    const formatted = topResults
      .map((r, i) => {
        const location = `${r.path}:${r.startLine}-${r.endLine}`;
        const score = (r.score * 100).toFixed(0);
        const preview = compactPreview(r.snippet);
        return `[${i}] ${location} (${score}%) — ${preview}`;
      })
      .join("\n");

    return { content: [{ type: "text", text: formatted }] };
  }

  private async knowledgeGraph(params: KnowledgeGraphParams): Promise<ToolResult> {
    const instancesToSearch = this.filterInstances(params.directories);
    if (!instancesToSearch) {
      const available = this.getDirectories().join(", ");
      return {
        content: [{ type: "text", text: `No matching directories found. Available: ${available}` }],
        isError: true,
      };
    }

    const depth = Math.min(params.depth ?? 1, 3);
    const allNeighbors: Array<{ id: string; depth: number; relation: string; layer: string | null; memoryDir: string }> = [];

    for (const instance of instancesToSearch) {
      const neighbors = instance.minimem.getGraphNeighbors(params.nodeId, depth, {
        relation: params.relation,
        layer: params.layer,
      });

      for (const n of neighbors) {
        allNeighbors.push({
          id: n.id,
          depth: n.depth,
          relation: n.link.relation,
          layer: n.link.layer,
          memoryDir: instance.name ?? instance.memoryDir,
        });
      }
    }

    if (allNeighbors.length === 0) {
      return { content: [{ type: "text", text: `No neighbors found for node "${params.nodeId}".` }] };
    }

    const formatted = allNeighbors
      .map((n) => `  [depth=${n.depth}] ${n.id} —(${n.relation})${n.layer ? ` [${n.layer}]` : ""}`)
      .join("\n");

    return {
      content: [{ type: "text", text: `Neighbors of "${params.nodeId}":\n${formatted}` }],
    };
  }

  private async knowledgePath(params: KnowledgePathParams): Promise<ToolResult> {
    const instancesToSearch = this.filterInstances(params.directories);
    if (!instancesToSearch) {
      const available = this.getDirectories().join(", ");
      return {
        content: [{ type: "text", text: `No matching directories found. Available: ${available}` }],
        isError: true,
      };
    }

    const maxDepth = Math.min(params.maxDepth ?? 3, 5);

    // Try each instance until a path is found
    for (const instance of instancesToSearch) {
      const path = instance.minimem.getGraphPath(params.fromId, params.toId, maxDepth);
      if (path.length > 0) {
        const steps = path
          .map((link) => `  ${link.fromId} —(${link.relation})→ ${link.toId}`)
          .join("\n");
        return {
          content: [{
            type: "text",
            text: `Path from "${params.fromId}" to "${params.toId}" (${path.length} steps):\n${steps}`,
          }],
        };
      }
    }

    return {
      content: [{
        type: "text",
        text: `No path found from "${params.fromId}" to "${params.toId}" within depth ${maxDepth}.`,
      }],
    };
  }
}

/**
 * Generate a compact preview from a snippet (~80 chars).
 * Prefers the first heading or first non-empty line.
 */
function compactPreview(snippet: string): string {
  const maxLen = 80;
  const lines = snippet.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "(empty)";

  // Prefer a heading line
  const heading = lines.find((l) => l.startsWith("#"));
  const text = heading ?? lines[0];
  // Strip markdown heading markers for cleaner display
  const cleaned = text.replace(/^#+\s*/, "").trim();

  if (cleaned.length <= maxLen) return `"${cleaned}"`;
  return `"${cleaned.slice(0, maxLen - 3)}..."`;
}

/**
 * Create a tool executor for the given Minimem instance(s)
 */
export function createToolExecutor(
  instances: Minimem | MemoryInstance | MemoryInstance[],
): MemoryToolExecutor {
  return new MemoryToolExecutor(instances);
}
