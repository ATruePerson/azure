import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

export const DESKTOP_BASE_DIR_NAME = ".azure-code";
export const LEGACY_DESKTOP_BASE_DIR_NAME = ".azure";

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  /** Existing T3 state wins so a rename never strands or overwrites it. */
  readonly legacyBaseDirExists?: boolean;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(
      input.homeDirectory,
      input.legacyBaseDirExists === true ? LEGACY_DESKTOP_BASE_DIR_NAME : DESKTOP_BASE_DIR_NAME,
    ),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
