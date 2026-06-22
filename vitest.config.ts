import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node", // Node 20 provides crypto.subtle / btoa / TextEncoder
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
