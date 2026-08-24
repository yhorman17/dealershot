import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    outDir: ".worker-verify",
    emptyOutDir: true,
    ssr: "scripts/verify-background-removal-runtime-entry.ts",
    rollupOptions: {
      output: { entryFileNames: "verify.mjs" },
    },
  },
  ssr: {
    noExternal: true,
    external: ["onnxruntime-node"],
  },
});
