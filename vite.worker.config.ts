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
  ssr: {
    noExternal: true,
    // ONNX Runtime resolves its platform-specific native addon relative to its
    // own package directory. Bundling it replaces that dynamic require with a
    // Rollup stub, so keep the package external beside the worker artifact.
    external: ["onnxruntime-node"],
  },
});
