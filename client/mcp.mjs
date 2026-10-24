#!/usr/bin/env node
// PaperSign MCP server over stdio. Register with:
//   claude mcp add papersign --scope user -- node <repo>/client/mcp.mjs
// Server: PAPERSIGN_URL. Key: PAPERSIGN_API_KEY, or the file in
// PAPERSIGN_KEY_FILE (default ~/.config/papersign/api-key).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPaperSignServer } from "./mcp-server.mjs";

await createPaperSignServer().connect(new StdioServerTransport());
