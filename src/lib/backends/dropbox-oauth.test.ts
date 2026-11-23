import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { KEYS } from "@/lib/utils/storage";
import { codeChallenge } from "@/lib/utils/pkce";
import { browser } from "@/lib/utils/ext";

// The app key is read at module load, so each test loads the module afresh with the env it
// wants. `browser` is the globalThis.chrome stub (test/polyfill-stub.ts), which ships no
// `identity`: it is set per test to model an engine.
const chromeStub = globalThis as unknown as { chrome: { identity?: unknown } };
const REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";

async function load(key = "testkey123") {
  vi.resetModules();
  vi.stubEnv("VITE_DROPBOX_APP_KEY", key);
  return import("./dropbox-oauth");
}

function withIdentity(launch: (o: { url: string }) => Promise<string | undefined>) {
  chromeStub.chrome.identity = { getRedirectURL: () => REDIRECT, launchWebAuthFlow: launch };
}

type Call = { url: string; init?: RequestInit };
function serve(answer: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return Promise.resolve(answer(c));
  });
  return calls;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const form = (c: Call) => new URLSearchParams(String(c.init?.body ?? ""));

afterEach(() => {
  delete chromeStub.chrome.identity;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Dropbox sign-in availability", () => {
  it("is unavailable without an app key, and says so rather than opening a window", async () => {
    const m = await load("");
    withIdentity(() => Promise.resolve(REDIRECT));
    expect(m.isDropboxAuthAvailable()).toBe(false);
    await expect(m.interactiveDropboxSignIn()).rejects.toThrow(/no Dropbox app key/i);
  });

  it("is unavailable where the browser has no auth window (Firefox for Android)", async () => {
    const m = await load();
    expect(m.isDropboxAuthAvailable()).toBe(false);
    await expect(m.interactiveDropboxSignIn()).rejects.toThrow(/isn't available in this browser/i);
  });

  it("is available with a key and launchWebAuthFlow", async () => {
    const m = await load();
    withIdentity(() => Promise.resolve(REDIRECT));
    expect(m.isDropboxAuthAvailable()).toBe(true);
  });
});

describe("Dropbox PKCE sign-in", () => {
  it("asks for an offline code with S256 on the bare redirect, and exchanges it with no secret", async () => {
    const m = await load();
    let authUrl = "";
    withIdentity(({ url }) => { authUrl = url; return Promise.resolve(`${REDIRECT}?code=the-code`); });
    const calls = serve((c) =>
      c.url.endsWith("/oauth2/token")
        ? json({ access_token: "at1", refresh_token: "rt1", expires_in: 14400, account_id: "dbid:AAA" })
        : json({ account_id: "dbid:AAA", email: "a@example.com", name: { display_name: "Ann" } })
    );

    const s = await m.interactiveDropboxSignIn();

    const q = new URL(authUrl).searchParams;
    expect(authUrl.startsWith("https://www.dropbox.com/oauth2/authorize?")).toBe(true);
    expect(q.get("client_id")).toBe("testkey123");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("token_access_type")).toBe("offline");
    expect(q.get("code_challenge_method")).toBe("S256");

    const tokenCall = calls.find((c) => c.url === "https://api.dropboxapi.com/oauth2/token")!;
    const body = form(tokenCall);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("client_id")).toBe("testkey123");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    expect(body.has("client_secret")).toBe(false);
    // The challenge sent up front is the hash of the verifier sent at exchange.
    expect(await codeChallenge(body.get("code_verifier")!)).toBe(q.get("code_challenge"));

    expect(s).toMatchObject({ access_token: "at1", refresh_token: "rt1", account_id: "dbid:AAA", email: "a@example.com", displayName: "Ann" });
    const stored = (await browser.storage.local.get(KEYS.DROPBOX_SESSION))[KEYS.DROPBOX_SESSION];
    expect(stored.refresh_token).toBe("rt1");
    expect(stored.expires_at).toBeGreaterThan(Date.now() + 14_000_000);
  });

  // 2026-11-23, the first real sign-in: the code exchange answered 429 with 60 lines of a
  // server stack trace as plain text (Dropbox creating the App folder), and that text was
  // the error on screen. The exchange is retried now, and the screen gets a sentence.
  const TRACE = "Request has been rate limited! rpc error: code = ResourceExhausted\n" + "go/src/dropbox/courier/status/errors.go:84 +0x7882746\n".repeat(60);

  it("retries the code exchange after a 429 with Retry-After", async () => {
    const m = await load();
    withIdentity(() => Promise.resolve(`${REDIRECT}?code=the-code`));
    let tokenCalls = 0;
    serve((c) => {
      if (!c.url.endsWith("/oauth2/token")) return json({ account_id: "dbid:AAA", email: "", name: { display_name: "Ann" } });
      return ++tokenCalls === 1
        ? new Response(TRACE, { status: 429, headers: { "Retry-After": "0", "Content-Type": "text/plain" } })
        : json({ access_token: "at1", refresh_token: "rt1", expires_in: 14400 });
    });
    const s = await m.interactiveDropboxSignIn();
    expect(tokenCalls).toBe(2);
    expect(s.refresh_token).toBe("rt1");
  });

  it("puts a sentence on screen, not Dropbox's raw error text", async () => {
    const m = await load();
    withIdentity(() => Promise.resolve(`${REDIRECT}?code=the-code`));
    serve(() => new Response(TRACE, { status: 400, headers: { "Content-Type": "text/plain" } }));
    const err = await m.interactiveDropboxSignIn().catch((e: Error) => e);
    expect((err as Error).message).toBe("Dropbox didn't accept the sign-in (HTTP 400). Try again.");
  });

  it("reports a closed window as closed, on both engines' wording", async () => {
    const m = await load();
    for (const words of ["The user did not approve access.", "User cancelled or denied access."]) {
      withIdentity(() => Promise.reject(new Error(words)));
      await expect(m.interactiveDropboxSignIn()).rejects.toThrow(/window closed before the sign-in came back/i);
    }
  });

  it("says the user declined only when Dropbox says access_denied", async () => {
    const m = await load();
    withIdentity(() => Promise.resolve(`${REDIRECT}?error=access_denied&error_description=The+user+chose+not+to+give+your+app+access`));
    await expect(m.interactiveDropboxSignIn()).rejects.toThrow(/not allowed on Dropbox's consent screen/i);
  });

  it("keeps a working session when a new sign-in is abandoned", async () => {
    const m = await load();
    const kept = { access_token: "old", refresh_token: "rt-old", expires_at: Date.now() + 3_600_000, account_id: "dbid:A", email: "", displayName: "", savedAt: 0 };
    await browser.storage.local.set({ [KEYS.DROPBOX_SESSION]: kept });
    withIdentity(() => Promise.reject(new Error("The user did not approve access.")));
    await expect(m.interactiveDropboxSignIn()).rejects.toThrow();
    expect((await browser.storage.local.get(KEYS.DROPBOX_SESSION))[KEYS.DROPBOX_SESSION]).toEqual(kept);
  });
});

describe("Dropbox access tokens", () => {
  const session = (over: Record<string, unknown> = {}) => ({
    access_token: "at-old", refresh_token: "rt1", expires_at: Date.now() + 3_600_000,
    account_id: "dbid:A", email: "a@example.com", displayName: "Ann", savedAt: 0, ...over,
  });
  beforeEach(async () => { await browser.storage.local.remove(KEYS.DROPBOX_SESSION); });

  it("hands out a current token without a request", async () => {
    const m = await load();
    await browser.storage.local.set({ [KEYS.DROPBOX_SESSION]: session() });
    const calls = serve(() => json({}));
    expect(await m.getDropboxAccessToken()).toBe("at-old");
    expect(calls).toHaveLength(0);
  });

  it("refreshes an expiring token with the refresh token and the key alone, and keeps the refresh token", async () => {
    const m = await load();
    await browser.storage.local.set({ [KEYS.DROPBOX_SESSION]: session({ expires_at: Date.now() + 30_000 }) });
    const calls = serve(() => json({ access_token: "at-new", expires_in: 14400 }));
    expect(await m.getDropboxAccessToken()).toBe("at-new");
    const body = form(calls[0]);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt1");
    expect(body.get("client_id")).toBe("testkey123");
    expect(body.has("client_secret")).toBe(false);
    const stored = (await browser.storage.local.get(KEYS.DROPBOX_SESSION))[KEYS.DROPBOX_SESSION];
    expect(stored).toMatchObject({ access_token: "at-new", refresh_token: "rt1" });
  });

  it("refreshes a current token when forced (after a 401)", async () => {
    const m = await load();
    await browser.storage.local.set({ [KEYS.DROPBOX_SESSION]: session() });
    serve(() => json({ access_token: "at-forced", expires_in: 14400 }));
    expect(await m.getDropboxAccessToken(true)).toBe("at-forced");
  });

  it("asks for a new sign-in when Dropbox refuses the refresh token", async () => {
    const m = await load();
    await browser.storage.local.set({ [KEYS.DROPBOX_SESSION]: session({ expires_at: 0 }) });
    serve(() => json({ error: "invalid_grant", error_description: "refresh token is invalid or revoked" }, 400));
    await expect(m.getDropboxAccessToken()).rejects.toThrow(m.DROPBOX_EXPIRED_MSG);
  });

  it("leaves a 5xx from the token endpoint retryable", async () => {
    const m = await load();
    await browser.storage.local.set({ [KEYS.DROPBOX_SESSION]: session({ expires_at: 0 }) });
    serve(() => json({}, 503));
    const err = await m.getDropboxAccessToken().catch((e) => e);
    // From the module graph the reload made, the one withRetry will check against.
    const { HttpError, defaultShouldRetry } = await import("@/lib/utils/retry");
    expect(err).toBeInstanceOf(HttpError);
    expect(defaultShouldRetry(err)).toBe(true);
    expect(err.status).toBe(503);
  });

  it("says so when nobody signed in", async () => {
    const m = await load();
    await expect(m.getDropboxAccessToken()).rejects.toThrow(/Not signed in to Dropbox/);
  });
});

describe("Dropbox disconnect", () => {
  it("forgets the session and revokes its token", async () => {
    const m = await load();
    await browser.storage.local.set({
      [KEYS.DROPBOX_SESSION]: { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3_600_000, account_id: "dbid:A", email: "", displayName: "", savedAt: 0 },
    });
    const calls = serve(() => json(null));
    await m.clearDropboxSession();
    expect((await browser.storage.local.get(KEYS.DROPBOX_SESSION))[KEYS.DROPBOX_SESSION]).toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual(["https://api.dropboxapi.com/2/auth/token/revoke"]);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("still forgets when the revoke cannot reach Dropbox", async () => {
    const m = await load();
    await browser.storage.local.set({
      [KEYS.DROPBOX_SESSION]: { access_token: "at", expires_at: Date.now() + 3_600_000, account_id: "", email: "", displayName: "", savedAt: 0 },
    });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await m.clearDropboxSession();
    expect((await browser.storage.local.get(KEYS.DROPBOX_SESSION))[KEYS.DROPBOX_SESSION]).toBeUndefined();
  });
});
