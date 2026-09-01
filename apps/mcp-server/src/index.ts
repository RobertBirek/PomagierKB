// Wejście biblioteczne mcp-servera; proces uruchamia dist/server.js (bootstrap w server.ts).
export { buildServer, start, type BuildServerOptions, type McpServerBundle } from './server.js';
export { loadConfig, buildToolLlm, sharedMigrationsDir, type McpConfig } from './config.js';
export type { KbTool, ToolCtx, ToolResult, ProfileRow, ToolLlm } from './tools/types.js';
