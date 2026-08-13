// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads persisted settings synchronously before app services are available.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";
import { HostProcessPlatform } from "@azure/shared/hostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import {
  LEGACY_DESKTOP_BASE_DIR_NAME,
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

export function readCommandLineSwitchValue(
  commandLine: DesktopPreReadyCommandLineReader,
  switchName: string,
): string | null {
  if (!commandLine.hasSwitch(switchName)) {
    return null;
  }

  const value = commandLine.getSwitchValue(switchName).trim();
  return value.length > 0 ? value : null;
}

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
      joinPath: NodePath.posix.join,
      readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
      pathExists: NodeFS.existsSync,
    });

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
    readonly stateDir: string;
    readonly isDevelopment: boolean;
    readonly userDataPath: string;
  }
>()("@azure/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

interface DesktopPreReadyPathsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly joinPath: JoinPath;
  readonly pathExists: (path: string) => boolean;
}

export function resolveDesktopPreReadyPaths(input: DesktopPreReadyPathsInput) {
  const isDevelopment = (input.env.VITE_DEV_SERVER_URL?.trim().length ?? 0) > 0;
  const t3Home = Option.fromUndefinedOr(input.env.AZURE_HOME);
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
    legacyBaseDirExists: input.pathExists(
      input.joinPath(input.homeDirectory, LEGACY_DESKTOP_BASE_DIR_NAME),
    ),
  });
  const appDataDirectory =
    input.platform === "win32"
      ? input.env.APPDATA?.trim() || input.joinPath(input.homeDirectory, "AppData", "Roaming")
      : input.platform === "darwin"
        ? input.joinPath(input.homeDirectory, "Library", "Application Support")
        : input.env.XDG_CONFIG_HOME?.trim() || input.joinPath(input.homeDirectory, ".config");
  const legacyUserDataPath = input.joinPath(
    appDataDirectory,
    isDevelopment ? "Azure Code (Dev)" : "Azure Code (Alpha)",
  );

  return {
    stateDir: resolveDesktopStateDir({
      baseDir,
      isDevelopment,
      joinPath: input.joinPath,
      t3Home,
    }),
    isDevelopment,
    userDataPath: input.pathExists(legacyUserDataPath)
      ? legacyUserDataPath
      : input.joinPath(appDataDirectory, isDevelopment ? "azure-code-dev" : "azure-code"),
  };
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const paths = resolveDesktopPreReadyPaths({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
      platform,
      joinPath: NodePath.join,
      pathExists: NodeFS.existsSync,
    });
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;

    if (linux !== null) {
      Electron.app.commandLine.appendSwitch("class", linux.linuxWmClass);
      if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
        Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
      }
    }
    Electron.app.setPath("userData", paths.userDataPath);

    return { linux, linuxPasswordStoreCommandLine, ...paths };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Keep Electron's strict pre-ready setup isolated so later runtime layers cannot
// observe app readiness before scheme privileges and command-line switches exist.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
