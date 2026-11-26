import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2023",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://localhost:8787" },
  },
});
