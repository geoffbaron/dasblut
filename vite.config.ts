import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, open: false },
  preview: {
    port: parseInt(process.env.PORT ?? "4173"),
    host: "0.0.0.0",
  },
});
