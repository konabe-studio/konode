import { describe, it, expect, afterEach } from "vitest";
import { isDriveAuthAvailable, interactiveSignIn } from "./gdrive-oauth";
import { KEYS } from "@/lib/utils/storage";

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

  // A redirect_uri_mismatch is invisible from here: Google shows its own error page in
  // the auth window and never redirects back, so the user closes it. Every non-"cancel"
  // failure used to be reported as "isn't available in this browser", which blames the
  // engine for what is an OAuth-client configuration problem — and misleads whoever is
  // trying to get that redirect registered.
  it("treats 'did not approve' (a closed window) as a cancel, not an unsupported browser", async () => {
    chromeStub.chrome.identity = {
      getRedirectURL: () => "https://ext.example/gdrive",
      launchWebAuthFlow: () => Promise.reject(new Error("The user did not approve access.")),
    };
    await expect(interactiveSignIn()).rejects.toThrow(/cancel/i);
    await expect(interactiveSignIn()).rejects.not.toThrow(/isn't available in this browser/i);
  });

  it("does not blame the browser for a generic flow failure", async () => {
    chromeStub.chrome.identity = {
      getRedirectURL: () => "https://ext.example/gdrive",
      launchWebAuthFlow: () => Promise.reject(new Error("Authorization page could not be loaded.")),
    };
    await expect(interactiveSignIn()).rejects.toThrow(/didn't complete/i);
    await expect(interactiveSignIn()).rejects.not.toThrow(/isn't available in this browser/i);
  });

  it("mentions the redirect URL in the log so it can be registered", async () => {
    const redirect = "https://abc-123.extensions.allizom.org/gdrive";
    chromeStub.chrome.identity = {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: () => Promise.reject(new Error("Authorization page could not be loaded.")),
    };
    await expect(interactiveSignIn()).rejects.toThrow();

    // logger.* fires appendAudit unawaited.
    await new Promise((r) => setTimeout(r, 0));
    const log = JSON.stringify((await chrome.storage.local.get(KEYS.AUDIT_LOG))[KEYS.AUDIT_LOG] ?? []);
    expect(log).toContain(redirect);
  });
});
