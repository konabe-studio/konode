import { describe, it, expect } from "vitest";
import {
  loadDraft, saveDraft, clearDraft, clearExpiredDraft, DRAFT_TTL_MS, type OnboardingDraft,
} from "@/lib/onboarding-draft";
import { KEYS } from "@/lib/utils/storage";

// #38: the wizard's answers were component state with nothing behind it, so a reload, or a
// phone discarding the tab during Google's consent, put the user back at Start setup with
// every answer gone. The wizard itself has no component-test harness; this is the part that
// decides what comes back.

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

const DRAFT: Omit<OnboardingDraft, "savedAt"> = {
  step: "backend",
  deviceLabel: "Laptop",
  provider: "github",
  githubToken: "github_pat_example",
  githubRepo: "me/konode-sync",
  githubBranch: "main",
  webdavUrl: "",
  webdavUser: "",
  webdavPass: "",
  ncHost: "",
  dataTypes: { bookmarks: true, history: true, sessions: false, extensions: false },
};

const stored = async (): Promise<unknown> =>
  (await chrome.storage.local.get(KEYS.ONBOARDING_DRAFT))[KEYS.ONBOARDING_DRAFT];

describe("the setup wizard's draft", () => {
  it("comes back as it was saved, the GitHub token included", async () => {
    await saveDraft(DRAFT, NOW);

    expect(await loadDraft(NOW + 60_000)).toEqual({ ...DRAFT, savedAt: NOW });
  });

  it("is dropped, and removed from storage, once it is more than a day old", async () => {
    // A setup from last week, against credentials since revoked, is not picked up again,
    // and the token it holds does not stay behind.
    await saveDraft(DRAFT, NOW);

    expect(await loadDraft(NOW + DRAFT_TTL_MS + 1)).toBeNull();
    expect(await stored()).toBeUndefined();
  });

  it("is still there just inside the day", async () => {
    await saveDraft(DRAFT, NOW);

    expect(await loadDraft(NOW + DRAFT_TTL_MS)).not.toBeNull();
  });

  it("is dropped when it claims to come from the future", async () => {
    await saveDraft(DRAFT, NOW + 60_000);

    expect(await loadDraft(NOW)).toBeNull();
  });

  it("never returns to a step past the settings being saved", async () => {
    await chrome.storage.local.set({ [KEYS.ONBOARDING_DRAFT]: { ...DRAFT, savedAt: NOW, step: "syncing" } });

    expect(await loadDraft(NOW)).toBeNull();
  });

  it("is dropped when it names a storage card this build does not have", async () => {
    await chrome.storage.local.set({ [KEYS.ONBOARDING_DRAFT]: { ...DRAFT, savedAt: NOW, provider: "gitea" } });

    expect(await loadDraft(NOW)).toBeNull();
  });

  it("reads back nothing it does not know, a passphrase least of all", async () => {
    // The passphrase is the one secret Konode never writes down. Nothing in the wizard puts
    // one in the draft, and should anything ever try, it does not come back out.
    await chrome.storage.local.set({
      [KEYS.ONBOARDING_DRAFT]: { ...DRAFT, savedAt: NOW, encPass: "correct horse battery", encEnabled: true },
    });

    const draft = await loadDraft(NOW);

    expect(Object.keys(draft ?? {}).sort()).toEqual(Object.keys({ ...DRAFT, savedAt: NOW }).sort());
    expect(JSON.stringify(draft)).not.toContain("correct horse battery");
  });

  it("fills in what an incomplete draft lacks, with the wizard's own defaults", async () => {
    await chrome.storage.local.set({ [KEYS.ONBOARDING_DRAFT]: { savedAt: NOW, step: "data", provider: null } });

    expect(await loadDraft(NOW)).toMatchObject({
      step: "data", provider: null, githubToken: "", githubBranch: "main", webdavPass: "",
      dataTypes: { bookmarks: true, history: false, sessions: false, extensions: false },
    });
  });

  it("goes when setup completes", async () => {
    await saveDraft(DRAFT, NOW);
    await clearDraft();

    expect(await stored()).toBeUndefined();
  });
});

describe("the worker's clean-up of an abandoned setup", () => {
  it("drops an expired draft and says so", async () => {
    await saveDraft(DRAFT, NOW);

    expect(await clearExpiredDraft(NOW + DRAFT_TTL_MS + 1)).toBe(true);
    expect(await stored()).toBeUndefined();
  });

  it("leaves a fresh one alone, and does nothing without one", async () => {
    expect(await clearExpiredDraft(NOW)).toBe(false);

    await saveDraft(DRAFT, NOW);
    expect(await clearExpiredDraft(NOW + 60_000)).toBe(false);
    expect(await stored()).toMatchObject({ githubToken: "github_pat_example" });
  });
});
