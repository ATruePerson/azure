import { existsSync } from "node:fs";
import { join } from "node:path";
import { azureConfigDir, ConfigStore, loadConfig } from "./config.ts";
import { configureCodex, installClaudeSearch, mcpInvocation, removeCodexRouting } from "./client-config.ts";
import { serveAzureSearch } from "./mcp.ts";
import { startServer } from "./server.ts";

function usage(): never {
  console.log(`azure — local provider gateway

Usage:
  azure                       Start the loopback gateway
  azure setup                 Validate the Azure config
  azure doctor                Validate providers and routes
  azure models                List configured models
  azure claude [args]         Start Azure and launch Claude Code
  azure codex setup [--model] Configure Codex to use Azure
  azure codex remove          Remove Azure/ACC-owned Codex routing
  azure codex status           Show safe Codex routing status
  azure mcp install            Write Azure Search MCP config
  azure mcp serve search       Serve Azure Search over stdio
  azure mcp doctor             Validate Azure Search
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length) { await startServer(new ConfigStore()); return; }
  const command = args.shift();
  if (command === "help" || command === "--help") usage();
  if (command === "start") { await startServer(new ConfigStore()); return; }
  if (command === "mcp" && args[0] === "serve" && args[1] === "search") { await serveAzureSearch(); return; }
  const config = await loadConfig();
  if (command === "setup" || command === "doctor") { console.log(`Azure config OK · ${Object.keys(config.providers).length} providers · ${Object.keys(config.models).length} models`); return; }
  if (command === "models") { for (const [id, model] of Object.entries(config.models).filter(([, model]) => model.enabled)) console.log(`${id}\t${model.display_name}`); return; }
  if (command === "codex") {
    const subcommand = args.shift() || "status";
    if (subcommand === "setup") {
      const index = args.indexOf("--model");
      const model = index >= 0 ? args[index + 1] : undefined;
      console.log(JSON.stringify(await configureCodex(config, model), null, 2));
      return;
    }
    if (subcommand === "remove" || subcommand === "restore") { console.log(JSON.stringify(await removeCodexRouting(), null, 2)); return; }
    if (subcommand === "status") { const path = process.env.CODEX_HOME || join(process.env.HOME || "/Users/unknown", ".codex"); console.log(JSON.stringify({ config: join(path, "config.toml"), azure: existsSync(join(path, "config.toml")) ? "inspect config for model_provider=azure" : "not configured" }, null, 2)); return; }
    usage();
  }
  if (command === "mcp") {
    if (args[0] === "install") {
      if (args.includes("--claude-3p")) {
        const invocation = mcpInvocation();
        console.log(await installClaudeSearch(invocation.command, undefined, invocation.args));
        return;
      }
      const path = join(azureConfigDir(), "mcp.json");
      const invocation = mcpInvocation();
      await Bun.write(path, JSON.stringify({ mcpServers: { "azure-search": { type: "stdio", command: invocation.command, args: invocation.args } } }, null, 2) + "\n");
      console.log(path); return;
    }
    if (args[0] === "doctor") { console.log("Azure Search OK · web_search, web_fetch"); return; }
    usage();
  }
  if (command === "claude") {
    const server = await startServer(new ConfigStore());
    const invocation = mcpInvocation();
    await installClaudeSearch(invocation.command, undefined, invocation.args);
    const child = Bun.spawn(["claude", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` } });
    await child.exited;
    server.stop();
    return;
  }
  usage();
}

main().catch((error) => { console.error(`azure: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
