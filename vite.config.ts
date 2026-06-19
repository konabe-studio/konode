import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { resolve } from "path";

// Manual multi-page build config.
// Replaces vite-plugin-web-extension to avoid the
// inlineDynamicImports conflict with multiple inputs.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup:      resolve(__dirname, "popup.html"),
        options:    resolve(__dirname, "options.html"),
        onboarding: resolve(__dirname, "onboarding.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
