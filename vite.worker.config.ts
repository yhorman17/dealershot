import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    outDir: ".worker",
    emptyOutDir: true,
    ssr: "worker/index.ts",
    rollupOptions: {
      output: { entryFileNames: "index.mjs" },
    },
  },
  ssr: { noExternal: true },
});
