import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { fetchWebPage, runSearch } from "./search.ts";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="128" fill="#0879f9"/><circle cx="228" cy="228" r="112" fill="none" stroke="white" stroke-width="42"/><path d="m310 310 104 104" fill="none" stroke="white" stroke-linecap="round" stroke-width="42"/><path d="M120 228h216M228 120v216" opacity=".22" stroke="white" stroke-width="18"/></svg>`;
export const AZURE_SEARCH_ICON = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export function createAzureSearchServer(): McpServer {
  const server = new McpServer({ name: "azure-search", title: "Azure Search", version: "1.0.0", icons: [{ src: AZURE_SEARCH_ICON, mimeType: "image/svg+xml", sizes: ["512x512"] }] });
  server.registerTool("web_search", {
    title: "Azure Search",
    description: "Search the public web, Hacker News, GitHub, Polymarket, and Reddit. Individual source failures are returned with successful results.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      count: z.number().int().min(1).max(10).optional().describe("Results per source"),
      sources: z.array(z.enum(["hackernews", "github", "polymarket", "reddit", "web"])).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const input = args as { query: string; count?: number; sources?: string[] };
    const query = input.query || "";
    if (!query.trim()) return { isError: true, content: [{ type: "text", text: "ERROR: query is required" }] };
    const count = input.count ?? 6;
    const sources = input.sources || [];
    const result = await runSearch(query, count, sources);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  server.registerTool("web_fetch", {
    title: "Azure Search Fetch",
    description: "Fetch readable text from one public HTTP(S) URL. Private networks, redirects, binaries, and oversized responses are blocked.",
    inputSchema: {
      url: z.string().url().describe("Public HTTP(S) URL"),
      maxChars: z.number().int().min(1).max(100000).optional().describe("Maximum readable characters"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const input = args as { url: string; maxChars?: number };
    const url = input.url || "";
    if (!url.trim()) return { isError: true, content: [{ type: "text", text: "ERROR: url is required" }] };
    try {
      const result = await fetchWebPage(url, { maxChars: input.maxChars ?? 50000 });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
  return server;
}

export async function serveAzureSearch(): Promise<void> {
  await createAzureSearchServer().connect(new StdioServerTransport());
}
