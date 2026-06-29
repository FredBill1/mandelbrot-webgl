import { defineConfig } from "vite";

export default defineConfig({
  test: {
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"]
  },
  worker: {
    format: "es"
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  }
});
