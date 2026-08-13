import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "test-echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back input",
      inputSchema: { type: "object", properties: { message: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "echo") {
    return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
  }
  throw new Error("Unknown tool");
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Server connected and waiting");

// Handle shutdown gracefully
process.on("SIGTERM", async () => {
  console.error("Server received SIGTERM");
  await server.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.error("Server received SIGINT");
  await server.close();
  process.exit(0);
});
