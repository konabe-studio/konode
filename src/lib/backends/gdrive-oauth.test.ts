import { describe, it, expect, afterEach, vi } from "vitest";
import { isDriveAuthAvailable, interactiveSignIn } from "./gdrive-oauth";
import { KEYS } from "@/lib/utils/storage";

// `browser` resolves to the globalThis.chrome stub (test/polyfill-stub.ts), which
// ships no `identity` — so we mutate it per test to model each engine.
const chromeStub = globalThis as unknown as { chrome: { identity?: unknown } };

afterEach(() => {
  delete chromeStub.chrome.identity;
  vi.unstubAllGlobals();
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

// Signing in used to begin by throwing the stored session away, which is fine on the
// happy path and destructive on every other one: the refresh token was gone before the
// consent window even opened, so closing that window left a device that had been syncing
// a minute earlier with no Drive session at all — while Settings still showed the account,
// because it only drops what it displays when you press Disconnect.
describe("a Drive sign-in that does not complete leaves the existing session alone", () => {
  const SESSION = {
    access_token: "at-old",
    refresh_token: "rt-old",
    expires_at: 4_000_000_000_000,
    email: "ben@example.com",
    displayName: "Ben",
    savedAt: 1_700_000_000_000,
  };

  const seed = () => chrome.storage.local.set({ [KEYS.GDRIVE_SESSION]: SESSION });
  const stored = async (): Promise<typeof SESSION | undefined> =>
    (await chrome.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION];

  /** The token endpoint and the userinfo call, the only two requests the flow makes. */
  function stubGoogle(token: Record<string, unknown>, email: string): void {
    vi.stubGlobal("fetch", (url: string) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(token) });
      }
      if (u.includes("drive/v3/about")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { emailAddress: email, displayName: "Someone" } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
  }

  const identity = (flow: () => Promise<string>) => {
    chromeStub.chrome.identity = { getRedirectURL: () => "https://ext.example/gdrive", launchWebAuthFlow: flow };
  };

  it("keeps it when the user closes the consent window", async () => {
    await seed();
    identity(() => Promise.reject(new Error("The user did not approve access.")));

    await expect(interactiveSignIn()).rejects.toThrow(/cancel/i);
    expect(await stored()).toEqual(SESSION);
  });

  it("keeps it when the flow fails for any other reason", async () => {
    await seed();
    identity(() => Promise.reject(new Error("Authorization page could not be loaded.")));

    await expect(interactiveSignIn()).rejects.toThrow(/didn't complete/i);
    expect(await stored()).toEqual(SESSION);
  });

  it("keeps it when the redirect comes back without a code", async () => {
    await seed();
    identity(() => Promise.resolve("https://ext.example/gdrive?error=access_denied"));

    await expect(interactiveSignIn()).rejects.toThrow(/access_denied/);
    expect(await stored()).toEqual(SESSION);
  });

  it("still replaces it when the flow succeeds", async () => {
    await seed();
    identity(() => Promise.resolve("https://ext.example/gdrive?code=auth-code"));
    stubGoogle({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }, "someone@example.com");

    const s = await interactiveSignIn();

    expect(s.access_token).toBe("at-new");
    expect(s.refresh_token).toBe("rt-new");
    expect((await stored())?.email).toBe("someone@example.com");
  });

  it("keeps the refresh token it had when Google returns none for the same account", async () => {
    // Losing it is what forces a re-consent, and re-consenting is what just happened.
    await seed();
    identity(() => Promise.resolve("https://ext.example/gdrive?code=auth-code"));
    stubGoogle({ access_token: "at-new", expires_in: 3600 }, SESSION.email);

    const s = await interactiveSignIn();

    expect(s.access_token).toBe("at-new");
    expect(s.refresh_token).toBe("rt-old");
  });

  it("does not inherit a refresh token across accounts", async () => {
    // Renewing one account's session with another account's refresh token would sync this
    // device into the wrong Drive, silently.
    await seed();
    identity(() => Promise.resolve("https://ext.example/gdrive?code=auth-code"));
    stubGoogle({ access_token: "at-new", expires_in: 3600 }, "someone-else@example.com");

    const s = await interactiveSignIn();

    expect(s.refresh_token).toBeUndefined();
  });
});
