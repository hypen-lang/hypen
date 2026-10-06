/**
 * Hypen application entry point (file-based layout).
 *
 * The App module and its `.hypen` template are discovered from
 * `src/components/*` by `serve({ source })`.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { serve } from "@hypen-space/server/remote";
import App from "./components/App/component";

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsDir = resolve(__dirname, "./components");

const server = await serve({
  module: App,
  moduleName: "App",
  source: componentsDir,
  port: Number(process.env.PORT) || 3000,
});

console.log(`Server running at ${server.url}`);
