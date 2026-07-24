import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { buildMemoryContext, loadEntries, searchEntries } from "./lifelog.mjs";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function listShape(entries, limit) {
  return entries.slice(-limit).map((entry) => ({
    id: entry.id,
    date: entry.date,
    filename: entry.filename,
    capturedAt: entry.capturedAt,
    durationSeconds: entry.durationSeconds,
    sizeBytes: entry.sizeBytes,
    status: entry.status,
    privacyLevel: entry.privacyLevel,
    videoUrl: entry.videoUrl,
    previewUrl: entry.previewUrl,
    thumbnailUrl: entry.thumbnailUrl,
    hasTranscript: Boolean(entry.transcript?.text),
  }));
}

export function createAfterimageMcpServer({ root, assetOrigin }) {
  const server = new McpServer(
    { name: "afterimage", version: "0.1.0" },
    { instructions: "Read-only access to daily video entries and transcripts. Verify source URLs before saving to memory." },
  );

  server.registerTool("list_daily_entries", {
    title: "List daily entries",
    description: "List daily videos ordered by capture time, with transcription status and source URLs. Optionally filter by date (YYYY-MM-DD).",
    annotations: READ_ONLY,
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ date, limit }) => {
    const entries = await loadEntries(root, { date: date || "", assetOrigin });
    return toolResult({ date: date || "", total: entries.length, items: listShape(entries, limit) });
  });

  server.registerTool("get_daily_entry", {
    title: "Get daily entry",
    description: "Get full metadata, transcript, and source URLs for a single video entry by ID.",
    annotations: READ_ONLY,
    inputSchema: { id: z.string().min(1).max(128) },
  }, async ({ id }) => {
    const entries = await loadEntries(root, { assetOrigin });
    const entry = entries.find((item) => item.id === id);
    if (!entry) return { isError: true, ...toolResult({ error: "entry_not_found", id }) };
    return toolResult(entry);
  });

  server.registerTool("search_daily_transcripts", {
    title: "Search transcripts",
    description: "Full-text search across video transcripts. Space-separated terms are AND-matched. Returns matching snippets with video source URLs.",
    annotations: READ_ONLY,
    inputSchema: {
      query: z.string().min(1).max(500),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(100).default(10),
    },
  }, async ({ query, date, limit }) => {
    const entries = await loadEntries(root, { date: date || "", assetOrigin });
    const result = searchEntries(entries, query, { date: date || "", limit });
    result.items = result.items.map((item) => ({ ...item, videoUrl: new URL(item.videoUrl, assetOrigin).href }));
    return toolResult(result);
  });

  server.registerTool("get_daily_memory_context", {
    title: "Daily memory context",
    description: "Get all videos for a date as a Markdown summary with source URLs. Suitable for AI agent memory ingestion.",
    annotations: READ_ONLY,
    inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
  }, async ({ date }) => {
    const entries = await loadEntries(root, { date, assetOrigin });
    return toolResult(buildMemoryContext(entries, date, { origin: assetOrigin }));
  });

  return server;
}

const CORS_HEADERS = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, last-event-id, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

export function sendMcpPreflight(response) {
  response.writeHead(204, CORS_HEADERS);
  response.end();
}

export async function handleMcpRequest(request, response, options) {
  const origin = request.headers.origin;
  if (origin && origin !== options.lifelogOrigin) {
    response.writeHead(403, { "content-type": "application/json; charset=utf-8", vary: "Origin" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Origin is not allowed." }, id: null }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createAfterimageMcpServer(options);
  await server.connect(transport);
  for (const [name, value] of Object.entries(CORS_HEADERS)) response.setHeader(name, value);
  try {
    await transport.handleRequest(request, response);
  } finally {
    if (!response.writableEnded) response.end();
    await server.close().catch(() => {});
  }
}
