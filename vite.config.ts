import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, open: false },
  preview: {
    port: parseInt(process.env.PORT ?? "4173"),
    host: "0.0.0.0",
    allowedHosts: true,
  },
  build: {
    // PixiJS v8 dynamically imports its WebGL/WebGPU renderers as separate code-split
    // chunks. On Railway those chunk requests 404'd (cache/hash mismatch), leaving a
    // blank canvas. Inlining dynamic imports folds the renderer into the single entry
    // bundle, so there are no separate /assets/*.js chunks that can fail to load.
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
