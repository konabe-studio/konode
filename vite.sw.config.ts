import { defineConfig } from "vite";
import path from "path";
import { resolve } from "path";

// Separate build for the MV3 service worker.
// Must be a single entry — that's why it's separate from the UI build.
// inlineDynamicImports is only safe with a single input.

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false, // don't wipe the UI build
    sourcemap: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/service-worker.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
  },
});
