import type { APIRoute } from "astro";

import { buildAzureProjectFileJsonSchema } from "@azure/shared/azureProjectFile";

// Rendered at build time; published at https://azure.codes/schema/azure.json so
// azure.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildAzureProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
