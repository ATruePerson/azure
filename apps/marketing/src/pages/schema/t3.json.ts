import type { APIRoute } from "astro";

import { buildT3ProjectFileJsonSchema } from "@azure/shared/t3ProjectFile";

// Rendered at build time; published at https://azure.codes/schema/t3.json so
// t3.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
