import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 版本號單一事實來源：package.json（tauri.conf.json / Cargo.toml 發版時同步），建置期注入 __APP_VERSION__。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/]wavesurfer\.js[\\/]/.test(id)) return "wavesurfer";
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
