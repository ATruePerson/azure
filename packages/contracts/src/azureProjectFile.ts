import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in Azure project file, resolved at the workspace root. */
export const AZURE_PROJECT_FILE_NAME = "azure.json";

/** Public URL of the published JSON Schema for {@link AzureProjectFile}. */
export const AZURE_PROJECT_FILE_SCHEMA_URL = "https://azure.codes/schema/azure.json";

const AZURE_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const AZURE_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const AzureProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the Azure Code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a Azure Code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into Azure Code.",
});
export type AzureProjectFileScript = typeof AzureProjectFileScript.Type;

export const AzureProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${AZURE_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Azure Code\'s built-in icon locations.',
      },
      AZURE_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(AzureProjectFileScript)
      .annotate({
        description:
          "Project scripts shared with everyone who opens this repository in Azure Code.",
      })
      .check(Schema.isMaxLength(AZURE_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "Azure project file",
  description:
    "Checked-in project configuration for Azure Code (azure.json at the repository root). See https://azure.codes for documentation.",
});
export type AzureProjectFile = typeof AzureProjectFile.Type;
