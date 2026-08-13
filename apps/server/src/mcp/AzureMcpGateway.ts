// @effect-diagnostics nodeBuiltinImport:off
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Effect from "effect/Effect";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  discoverEnabledAzureMcpServers,
  type AzureMcpServerDescriptor,
} from "../provider/AzureHomeCapabilities.ts";

export interface AzureMcpGatewayTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

interface ConnectedServer {
  readonly descriptor: AzureMcpServerDescriptor;
  readonly client: Client;
  readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
}

export interface AzureMcpGateway {
  readonly listTools: () => Effect.Effect<ReadonlyArray<AzureMcpGatewayTool>>;
  readonly callTool: (
    name: string,
    arguments_: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>>;
  readonly close: Effect.Effect<void>;
}

const toolName = (server: AzureMcpServerDescriptor, name: string) =>
  `${server.toolPrefix}__${name.replace(/[^A-Za-z0-9._-]/gu, "_")}`;

export interface AzureMcpGatewayInput {
  readonly descriptors?: ReadonlyArray<AzureMcpServerDescriptor>;
  /** Working directory handed to spawned stdio servers. */
  readonly cwd?: string;
}

const connect = async (
  descriptor: AzureMcpServerDescriptor,
  cwd: string | undefined,
): Promise<ConnectedServer> => {
  console.error(`[AzureMcpGateway] Connecting to ${descriptor.name} (${descriptor.transport})`);
  const client = new Client({ name: "Azure Code", version: "1" });
  const transport =
    descriptor.transport === "stdio"
      ? new StdioClientTransport({
          command: descriptor.command!,
          ...(descriptor.args ? { args: [...descriptor.args] } : {}),
          ...(descriptor.env ? { env: { ...descriptor.env } } : {}),
          ...(cwd ? { cwd } : {}),
          stderr: "inherit",
        })
      : new StreamableHTTPClientTransport(new URL(descriptor.url!), {
          ...(descriptor.headers ? { requestInit: { headers: descriptor.headers } } : {}),
        });
  await client.connect(transport as Transport);
  console.error(`[AzureMcpGateway] Connected to ${descriptor.name}`);
  return { descriptor, client, transport };
};

/**
 * One process-local gateway fronts trusted Azure MCP descriptors. It connects
 * on first listing, reuses clients, and makes a failed server invisible rather
 * than breaking the whole tool inventory. Descriptors default to the enabled
 * Azure home config; tests may inject them directly.
 */
export const makeAzureMcpGateway = (input: AzureMcpGatewayInput = {}) =>
  Effect.gen(function* () {
    const descriptors = input.descriptors
      ? [...input.descriptors]
      : yield* Effect.tryPromise(() => discoverEnabledAzureMcpServers()).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<AzureMcpServerDescriptor>),
        );
    const cwd = input.cwd;
    const connections = new Map<string, ConnectedServer>();
    const failed = new Set<string>();

    const getConnection = (descriptor: AzureMcpServerDescriptor) =>
      Effect.tryPromise(async () => {
        const current = connections.get(descriptor.id);
        if (current) return current;
        console.error(`[AzureMcpGateway] Attempting connection to ${descriptor.id}`);
        const connected = await connect(descriptor, cwd);
        console.error(`[AzureMcpGateway] Connected and cached ${descriptor.id}`);
        connections.set(descriptor.id, connected);
        return connected;
      }).pipe(
        Effect.tapError((err) => {
          console.error(`[AzureMcpGateway] Connection failed for ${descriptor.id}:`, err);
          return Effect.logWarning("Azure MCP server unavailable", {
            server: descriptor.name,
          }).pipe(Effect.andThen(Effect.sync(() => failed.add(descriptor.id))));
        }),
      );

    const markFailed = (descriptor: AzureMcpServerDescriptor, message: string) =>
      Effect.logWarning(message, { server: descriptor.name }).pipe(
        Effect.andThen(Effect.sync(() => failed.add(descriptor.id))),
      );

    const listTools = () =>
      Effect.forEach(
        descriptors.filter((descriptor) => !failed.has(descriptor.id)),
        (descriptor) =>
          getConnection(descriptor).pipe(
            Effect.flatMap((connection) =>
              Effect.tryPromise(() => connection.client.listTools()).pipe(
                Effect.map((result) =>
                  result.tools.map((tool) => ({
                    name: toolName(descriptor, tool.name),
                    ...(tool.description ? { description: tool.description } : {}),
                    inputSchema: tool.inputSchema as Record<string, unknown>,
                    ...(tool.annotations
                      ? {
                          annotations: {
                            ...(tool.annotations.readOnlyHint !== undefined
                              ? { readOnlyHint: tool.annotations.readOnlyHint }
                              : {}),
                            ...(tool.annotations.destructiveHint !== undefined
                              ? { destructiveHint: tool.annotations.destructiveHint }
                              : {}),
                            ...(tool.annotations.idempotentHint !== undefined
                              ? { idempotentHint: tool.annotations.idempotentHint }
                              : {}),
                            ...(tool.annotations.openWorldHint !== undefined
                              ? { openWorldHint: tool.annotations.openWorldHint }
                              : {}),
                          },
                        }
                      : {}),
                  })),
                ),
              ),
            ),
            Effect.tapError(() => markFailed(descriptor, "Azure MCP tool listing failed")),
            Effect.orElseSucceed(() => [] as ReadonlyArray<AzureMcpGatewayTool>),
          ),
        { concurrency: 1 },
      ).pipe(Effect.map((groups) => groups.flatMap((group) => group)));

    const callTool = (name: string, arguments_: Record<string, unknown>) => {
      const descriptor = descriptors.find((entry) => name.startsWith(`${entry.toolPrefix}__`));
      if (!descriptor || failed.has(descriptor.id)) {
        return Effect.succeed({
          isError: true,
          content: [{ type: "text", text: "Azure MCP tool is unavailable." }],
        });
      }
      const downstreamName = name.slice(`${descriptor.toolPrefix}__`.length);
      const failedResult = {
        isError: true,
        content: [{ type: "text", text: "Azure MCP server failed while running this tool." }],
      };
      return getConnection(descriptor).pipe(
        Effect.flatMap((connection) =>
          Effect.tryPromise(() =>
            connection.client.callTool({ name: downstreamName, arguments: arguments_ }),
          ),
        ),
        Effect.map((result) => result as Record<string, unknown>),
        Effect.tapError(() =>
          Effect.logWarning("Azure MCP tool invocation failed", { server: descriptor.name }).pipe(
            Effect.andThen(Effect.sync(() => failed.add(descriptor.id))),
          ),
        ),
        Effect.orElseSucceed(() => failedResult),
      );
    };

    return {
      listTools,
      callTool,
      close: Effect.suspend(() =>
        Effect.forEach([...connections.values()], (connection) =>
          Effect.tryPromise(async () => {
            if (connection.transport instanceof StreamableHTTPClientTransport) {
              await connection.transport.terminateSession().catch(() => undefined);
            }
            await connection.client.close();
          }).pipe(Effect.ignore),
        ).pipe(Effect.asVoid),
      ),
    };
  });
