// Bundles the extension in the current directory into a single
// self-contained dist/index.js. Extensions must not rely on node_modules at
// runtime: they run under the Node permission model, restricted to their
// own folder, and installed copies are moved out of the workspace.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("nexora.json", "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: manifest.main ?? "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Let bundled CommonJS dependencies call require().
  // CommonJS globals for bundled CommonJS libraries (e.g. Emscripten glue).
  // Imports are aliased so they can't clash with a library's own imports.
  banner: {
    js: [
      "import { createRequire as __nexoraCreateRequire } from 'node:module';",
      "import { fileURLToPath as __nexoraFileURLToPath } from 'node:url';",
      "import { dirname as __nexoraDirname } from 'node:path';",
      "const require = __nexoraCreateRequire(import.meta.url);",
      "const __filename = __nexoraFileURLToPath(import.meta.url);",
      "const __dirname = __nexoraDirname(__filename);",
    ].join(" "),
  },
  // WebAssembly codecs are embedded as bytes: extensions must not load
  // files from node_modules at runtime (the sandbox only grants their folder).
  loader: { ".wasm": "binary" },
  logLevel: "info",
});
