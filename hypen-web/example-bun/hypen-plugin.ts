/**
 * Bun plugin to import .hypen files as text strings
 */

import { plugin, type BunPlugin } from "bun";

const hypenPlugin: BunPlugin = {
  name: "hypen-loader",
  async setup(build) {
    const { readFileSync } = await import("fs");

    build.onLoad({ filter: /\.hypen$/ }, async (args) => {
      console.log("[Hypen Plugin] Loading:", args.path);

      const text = readFileSync(args.path, "utf-8");
      console.log("[Hypen Plugin] Content length:", text.length);
      console.log("[Hypen Plugin] First 100 chars:", text.substring(0, 100));

      return {
        contents: `export default ${JSON.stringify(text)};`,
        loader: "js",
      };
    });
  },
};

export default hypenPlugin;
