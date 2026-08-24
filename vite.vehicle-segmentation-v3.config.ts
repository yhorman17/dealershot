import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    outDir: ".worker-v3",
    emptyOutDir: true,
    ssr: "scripts/run-vehicle-segmentation-v3-child.mjs",
    rollupOptions: { output: { entryFileNames: "child.mjs" } },
  },
  ssr: { external: ["onnxruntime-node", "sharp"] },
});
