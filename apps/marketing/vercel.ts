import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@azure/marketing...'",
  buildCommand: "vp run --filter @azure/marketing build",
  outputDirectory: "dist",
};
