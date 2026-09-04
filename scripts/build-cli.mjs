// 打包 CLI：cli/aicut.ts → dist-cli/aicut.mjs（單檔、Node 20+），版本號取 package.json。
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

await build({
  entryPoints: [resolve(root, "cli/aicut.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(root, "dist-cli/aicut.mjs"),
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
