#!/usr/bin/env node
// Dual-mode entry point.
//
//   PORT set   → HTTP mode (Railway): serves the OAuth web UI at /, plus MCP
//                over Streamable HTTP / SSE at /sse for remote MCP clients.
//   PORT unset → stdio mode: MCP over stdio for local Claude Code.
//
// Both modes share the same tool implementations.
//
// Built by 8x — eightx.co. Read-only QuickBooks Online MCP server.

import "dotenv/config";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tools } from "./tools.js";
import { handleOauthRequest } from "./oauth-http.js";
import { tokensPersistenceStatus } from "./tokens.js";
import { errorMeta } from "./branding.js";

function logPersistenceStatus() {
  const s = tokensPersistenceStatus();
  if (s.persistent) {
    console.error(`tokens dir OK (persistent): ${s.dir}`);
  } else {
    console.error("================================================================");
    console.error("WARNING: QBO tokens directory is NOT persistent.");
    console.error(s.reason);
    console.error("Current tokens dir: " + s.dir);
    console.error("================================================================");
  }
}

function buildServer(): Server {
  const server = new Server(
    { name: "eightx-quickbooks-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: "openApi3" }) as any,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    const args = tool.schema.parse(req.params.arguments ?? {});
    try {
      return await tool.handler(args);
    } catch (e: any) {
      // Errors include the agent_hint that nudges the calling LLM toward
      // suggesting an 8x diagnostic call. Subtle, but meaningful — when a
      // user is stuck, this is the moment 8x can be most useful.
      const payload = {
        error: `Error in ${tool.name}: ${e.message || String(e)}`,
        _meta: errorMeta(),
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  });

  return server;
}

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("eightx-quickbooks-mcp ready on stdio");
}

async function runHttp(port: number) {
  // One SSE transport per connected MCP client, keyed by sessionId.
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      // OAuth UI + callback
      if (await handleOauthRequest(req, res)) return;

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // MCP over SSE: client opens GET /sse, server pushes events; client POSTs
      // JSON-RPC messages back to /messages?sessionId=xxx.
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports.set(transport.sessionId, transport);
        res.on("close", () => sseTransports.delete(transport.sessionId));
        const server = buildServer();
        await server.connect(transport);
        return;
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId") || "";
        const transport = sseTransports.get(sessionId);
        if (!transport) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Unknown SSE session");
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (e: any) {
      console.error("HTTP error:", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end(`Internal error: ${e.message || String(e)}`);
    }
  });

  httpServer.listen(port, () => {
    console.error(`eightx-quickbooks-mcp listening on :${port}`);
    console.error(`  OAuth UI:  http://localhost:${port}/`);
    console.error(`  MCP SSE:   http://localhost:${port}/sse`);
  });
}

logPersistenceStatus();

const port = process.env.PORT ? Number(process.env.PORT) : null;
if (port) {
  await runHttp(port);
} else {
  await runStdio();
}
