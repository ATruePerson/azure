import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const LiveLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(LiveLayer)("OpenCode CLI output", (it) => {
  it.effect("collects output larger than the process stream buffer", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(200_000))'],
        environment: process.env,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toHaveLength(200_000);
    }),
  );

  it.effect("gives isolated probes a writable OpenCode data root", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: process.execPath,
        args: [
          "-e",
          'const fs=require("node:fs");const p=process.env.XDG_DATA_HOME;if(!p||!fs.existsSync(p))process.exit(1);fs.mkdirSync(p+"/log");fs.writeFileSync(p+"/log/opencode.log","ok")',
        ],
        environment: process.env,
        isolatedDataHome: true,
      });

      expect(result.code).toBe(0);
    }),
  );
});

it.live("retries a transient skill inventory failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-retry-" });
      const binaryPath = path.join(directory, "opencode");
      const markerPath = path.join(directory, "skill-attempted");
      yield* fs.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then',
          '  if [ ! -f "$T3_SKILL_RETRY_MARKER" ]; then',
          '    touch "$T3_SKILL_RETRY_MARKER"',
          '    printf "database is locked\\n" >&2',
          "    exit 1",
          "  fi",
          // @effect-diagnostics-next-line preferSchemaOverJson:off - shell fixture needs a JSON literal.
          `  printf '%s\\n' '${JSON.stringify([
            { name: "fiction-writer", location: "/skills/fiction-writer/SKILL.md" },
          ])}'`,
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(binaryPath, 0o755);

      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        environment: { ...process.env, T3_SKILL_RETRY_MARKER: markerPath },
      });

      expect(inventory.skills).toEqual([
        { name: "fiction-writer", location: "/skills/fiction-writer/SKILL.md" },
      ]);
    }),
  ).pipe(Effect.provide(LiveLayer)),
);
