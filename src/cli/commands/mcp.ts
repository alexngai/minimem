/**
 * minimem mcp - Run as MCP server (stdio)
 */

import { Minimem } from "../../minimem.js";
import { createMcpServer, runMcpServer } from "../../server/mcp.js";
import {
  resolveMemoryDir,
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";

export type McpOptions = {
  dir?: string;
  global?: boolean;
  provider?: string;
};

export async function mcp(options: McpOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });

  // Check if initialized
  if (!(await isInitialized(memoryDir))) {
    // Write to stderr so it doesn't interfere with MCP JSON-RPC
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error(`Run: minimem init${options.dir ? ` ${options.dir}` : ""}`);
    process.exit(1);
  }

  // Load config and create Minimem instance
  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    provider: options.provider,
    watch: true, // Enable watching for MCP server
  });

  const minimem = await Minimem.create(config);
  const server = createMcpServer(minimem);

  // Handle shutdown gracefully
  const shutdown = () => {
    minimem.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Run the MCP server (this blocks)
  await runMcpServer(server);
}
