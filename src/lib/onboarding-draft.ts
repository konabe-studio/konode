/**
 * What the setup wizard has been told so far, kept across a reload (#38).
 *
 * Every answer used to be component state with nothing behind it, so reloading the page, or
 * a mobile browser discarding it in the background, brought the wizard back at Start setup
 * with everything gone and no word about it. OAuth leaves the page and comes back by
 * definition, which is how #37 surfaced: Google's consent was approved, the page did not
 * survive the trip, and the report was that Konode went "back to the first with 'start
 * setup' button".
 *
 * What is kept, and what is not:
 * - Where the wizard was, the device name, the storage card and its fields, and the data
 *   types. The GitHub token and the WebDAV password are kept too: GitHub shows a
 *   fine-grained token once, and both end up in the same storage the moment setup
 *   completes. What the completed case does not have is a token sitting there for a setup
 *   the user walked away from, so the draft lives a day at most (DRAFT_TTL_MS), goes the
 *   moment setup completes, and the worker drops an expired one (clearExpiredDraft).
 * - Nothing from the encryption step. The passphrase is the one secret Konode never
 *   writes down, a half-typed one is not worth changing that for, and that step is the
 *   cheapest of all to redo. A reload there comes back to the step with the choice unmade.
 * - Not the Google session either: interactiveSignIn has already stored it, and the wizard
 *   reads it from there (getStoredGDriveUser) rather than from a copy.
 */

import type { DataType } from "@/lib/types";
import { KEYS } from "@/lib/utils/storage";
import { browser } from "@/lib/utils/ext";
import { PROVIDERS, type ProviderId } from "@/lib/storage-providers";

/** The steps a draft can return to. Past `encrypt` the settings are saved and there is
 *  nothing left to keep. */
export type DraftStep = "welcome" | "backend" | "data" | "encrypt";
const DRAFT_STEPS: readonly DraftStep[] = ["welcome", "backend", "data", "encrypt"];

export interface OnboardingDraft {
  savedAt: number; // epoch ms
  step: DraftStep;
  deviceLabel: string;
  provider: ProviderId | null;
  githubToken: string;
  githubRepo: string;
  githubBranch: string;
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  ncHost: string;
  dataTypes: Record<DataType, boolean>;
}

/** A day: long enough for a discarded tab or a trip through Google's consent screen, short
 *  enough that a setup from last week, against credentials since revoked, is not quietly
 *  picked up again. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const DATA_TYPES: readonly DataType[] = ["bookmarks", "history", "sessions", "extensions"];

/** The draft, if one is stored, still fresh, and the shape this build writes. Anything else
 *  is dropped on the way out, so an expired or foreign draft never comes back. */
export async function loadDraft(now = Date.now()): Promise<OnboardingDraft | null> {
  const r = await browser.storage.local.get(KEYS.ONBOARDING_DRAFT);
  const raw = r[KEYS.ONBOARDING_DRAFT] as Partial<OnboardingDraft> | undefined;
  if (raw === undefined) return null;
  const draft = validDraft(raw, now);
  if (!draft) await clearDraft();
  return draft;
}

export async function saveDraft(draft: Omit<OnboardingDraft, "savedAt">, now = Date.now()): Promise<void> {
  await browser.storage.local.set({ [KEYS.ONBOARDING_DRAFT]: { ...draft, savedAt: now } });
}

export async function clearDraft(): Promise<void> {
  await browser.storage.local.remove(KEYS.ONBOARDING_DRAFT);
}

/** Drop a draft that has outlived DRAFT_TTL_MS. The wizard does this when it opens, but
 *  after an abandoned setup nothing may open it again, so the worker calls this too. True
 *  when something was dropped. */
export async function clearExpiredDraft(now = Date.now()): Promise<boolean> {
  const r = await browser.storage.local.get(KEYS.ONBOARDING_DRAFT);
  const raw = r[KEYS.ONBOARDING_DRAFT] as Partial<OnboardingDraft> | undefined;
  if (raw === undefined || validDraft(raw, now)) return false;
  await clearDraft();
  return true;
}

function validDraft(raw: Partial<OnboardingDraft>, now: number): OnboardingDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const savedAt = raw.savedAt;
  // A draft from the future is a clock that moved, and just as unsafe to trust.
  if (typeof savedAt !== "number" || savedAt > now || now - savedAt > DRAFT_TTL_MS) return null;
  if (!raw.step || !DRAFT_STEPS.includes(raw.step)) return null;
  if (raw.provider != null && !PROVIDERS.some((p) => p.id === raw.provider)) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const types = (raw.dataTypes ?? {}) as Partial<Record<DataType, unknown>>;
  return {
    savedAt,
    step: raw.step,
    deviceLabel: str(raw.deviceLabel),
    provider: raw.provider ?? null,
    githubToken: str(raw.githubToken),
    githubRepo: str(raw.githubRepo),
    githubBranch: str(raw.githubBranch) || "main",
    webdavUrl: str(raw.webdavUrl),
    webdavUser: str(raw.webdavUser),
    webdavPass: str(raw.webdavPass),
    ncHost: str(raw.ncHost),
    dataTypes: Object.fromEntries(
      DATA_TYPES.map((t) => [t, typeof types[t] === "boolean" ? (types[t] as boolean) : t === "bookmarks"])
    ) as Record<DataType, boolean>,
  };
}
