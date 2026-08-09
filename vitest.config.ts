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
    // The E2EE tests derive real keys at the shipped 600k PBKDF2 iterations, which is a
    // security parameter, not a knob to turn down for the suite: lowering it in tests would
    // leave the value we actually ship untested. Several of them derive more than once (a
    // round trip, then a wrong passphrase, then a verifier), so the default 5s is not enough
    // on a slower machine, and CI's faster runners hid it. What that cost was the worst kind
    // of red: four timed-out crypto tests that look like a broken encryption change and are
    // nothing of the sort. Generous on purpose, and it never fires when things are working.
    testTimeout: 30_000,
  },
});
