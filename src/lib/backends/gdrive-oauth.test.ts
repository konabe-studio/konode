import { describe, it, expect, afterEach } from "vitest";
import { isDriveAuthAvailable, interactiveSignIn } from "./gdrive-oauth";

// `browser` resolves to the globalThis.chrome stub (test/polyfill-stub.ts), which
// ships no `identity` — so we mutate it per test to model each engine.
const chromeStub = globalThis as unknown as { chrome: { identity?: unknown } };

afterEach(() => {
  delete chromeStub.chrome.identity;
});

describe("Drive auth availability gate", () => {
  it("reports unavailable when launchWebAuthFlow is absent (e.g. an engine without chrome.identity)", () => {
    expect(isDriveAuthAvailable()).toBe(false);
  });

  it("reports available when launchWebAuthFlow exists", () => {
    chromeStub.chrome.identity = { launchWebAuthFlow: () => Promise.resolve("") };
    expect(isDriveAuthAvailable()).toBe(true);
  });

  it("interactiveSignIn fails with a friendly message when the API is missing", async () => {
    await expect(interactiveSignIn()).rejects.toThrow(/isn't available in this browser/i);
  });

  it("maps an opaque native throw (iOS WebKit/Orion) to the friendly message, not the raw error", async () => {
    chromeStub.chrome.identity = {
      getRedirectURL: () => "https://ext.example/gdrive",
      // Orion exposes the method but throws this WebKit error when invoked.
      launchWebAuthFlow: () =>
        Promise.reject(new Error("undefined is not an object (evaluating 'parameters.length')")),
    };
    await expect(interactiveSignIn()).rejects.toThrow(/isn't available in this browser/i);
  });

  it("still reports a real user cancel as a cancel", async () => {
    chromeStub.chrome.identity = {
      getRedirectURL: () => "https://ext.example/gdrive",
      launchWebAuthFlow: () => Promise.reject(new Error("The user cancelled the sign-in flow.")),
    };
    await expect(interactiveSignIn()).rejects.toThrow(/cancel/i);
  });
});
