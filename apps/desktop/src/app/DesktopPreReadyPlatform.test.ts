import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@azure/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { appendSwitchMock, getSwitchValueMock, hasSwitchMock, registerSchemesMock, setPathMock } =
  vi.hoisted(() => ({
    appendSwitchMock: vi.fn(),
    getSwitchValueMock: vi.fn(),
    hasSwitchMock: vi.fn(),
    registerSchemesMock: vi.fn(),
    setPathMock: vi.fn(),
  }));

vi.mock("electron", () => ({
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
    setPath: setPathMock,
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setPathMock.mockReset();
  });

  it("reads an explicit Electron command-line switch value", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: (switchName) => switchName === "password-store",
        getSwitchValue: (switchName) => {
          assert.equal(switchName, "password-store");
          return "basic";
        },
      },
      "password-store",
    );

    assert.equal(value, "basic");
  });

  it("treats valueless Electron command-line switches as absent", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => true,
        getSwitchValue: () => "",
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it("returns null for missing Electron command-line switches", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => false,
        getSwitchValue: () => {
          throw new Error("Unexpected switch value read.");
        },
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it("resolves the legacy production state and user-data paths before startup", () => {
    const existingPaths = new Set([
      "/Users/test/.azure",
      "/Users/test/Library/Application Support/Azure Code (Alpha)",
    ]);

    assert.deepEqual(
      DesktopPreReadyPlatform.resolveDesktopPreReadyPaths({
        env: {},
        homeDirectory: "/Users/test",
        platform: "darwin",
        joinPath: (first, ...segments) => [first, ...segments].join("/"),
        pathExists: (path) => existingPaths.has(path),
      }),
      {
        stateDir: "/Users/test/.azure/userdata",
        isDevelopment: false,
        userDataPath: "/Users/test/Library/Application Support/Azure Code (Alpha)",
      },
    );
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@azure/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });
        setPathMock.mockImplementation(() => {
          events.push("user-data");
        });

        const preReadyLayer = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
        );

        const clerkShapedLayer = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const runtimeLayer = clerkShapedLayer.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(preReadyLayer),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(result.clerk, { ready: true });
        assert.equal(result.preReady.linux, null);
        assert.equal(result.preReady.linuxPasswordStoreCommandLine, null);
        assert.equal(result.preReady.isDevelopment, false);
        assert.isNotEmpty(result.preReady.stateDir);
        assert.isNotEmpty(result.preReady.userDataPath);
        assert.deepEqual(events, ["pre-ready", "user-data", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(setPathMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
      }),
  );
});
