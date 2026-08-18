import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: fixtureDirectory,
  publicDir: path.resolve(fixtureDirectory, "..", "..", "public"),
  resolve: {
    alias: {
      "@": path.resolve(fixtureDirectory, "..", "..", "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
