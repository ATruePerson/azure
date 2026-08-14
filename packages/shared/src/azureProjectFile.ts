import * as Schema from "effect/Schema";

import { AzureProjectFile, AZURE_PROJECT_FILE_SCHEMA_URL } from "@azure/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `azure.json` file contents (lenient JSONC string) and the
 * decoded {@link AzureProjectFile}.
 */
export const AzureProjectFileFromJson = fromLenientJson(AzureProjectFile);

/**
 * Build the publishable JSON Schema document for `azure.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link AZURE_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildAzureProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(AzureProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: AZURE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
