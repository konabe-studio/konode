import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The real polyfill throws when imported outside an extension; the fake in
      // test/setup.ts is already promise-based, so hand that back instead.
      "webextension-polyfill": path.resolve(__dirname, "./test/polyfill-stub.ts"),
    },
  },
  test: {
    environment: "node", // Node 20 provides crypto.subtle / btoa / TextEncoder
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
