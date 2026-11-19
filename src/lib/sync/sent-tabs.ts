/**
 * Send a tab to another device (#92).
 *
 * Konode has no server, so a sent tab travels the way everything else does: through the
 * user's own storage. Every device publishes one small file, `konode_sent_<device_id>.json`,
 * holding the tabs it sent that their receivers have not confirmed yet, and the ids of the
 * tabs it opened itself. On each sync a device reads the others' files, opens what was sent
 * to it, and confirms it by listing the id in its own file; the sender then drops the tab.
 * So a tab arrives on the receiver's next sync, not at once, and a browser that is closed
 * gets it once it starts and syncs.
 *
 * The file is written even with nothing in it. It names the device, and its presence is what
 * makes the device a target: a device on an older build never writes one and would never
 * open what it was sent, so it is never offered.
 *
 * The payload is encrypted exactly like a sync packet when E2EE is on, with the checksum
 * over the plaintext. A file this device cannot read under its own E2EE setting (plaintext
 * while it encrypts, encrypted while it does not, another passphrase) is skipped, and that
 * device is not offered as a target either: it could not read what we would send.
 */
import type { IBackend, SyncSettings, SentTab, SentTabsFile, SentTabsPayload, SendTarget } from "@/lib/types";
import { encrypt, decrypt, sha256 } from "@/lib/crypto/encryption";
import { browser } from "@/lib/utils/ext";
import { KEYS, updateKey } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { isSafeContentUrl } from "@/lib/utils/url";

/** How long a sent tab waits for its receiver, and how long an opened id is confirmed. */
export const SENT_TAB_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** At most this many tabs wait in one device's file. The oldest go first. */
const MAX_PENDING = 100;
const PREFIX = "konode_sent_";

export const sentFileName = (deviceId: string): string => `${PREFIX}${deviceId}.json`;

/** Only web pages travel: a receiver must never be made to open a `javascript:` or `file:` URL. */
export function sendableUrl(url: string | undefined | null): boolean {
  return isSafeContentUrl(url);
}

/** What this device remembers between exchanges. */
interface ExchangeMemory {
  /** Checksum of the payload last written to our own file, so an unchanged one is not rewritten. */
  written: string | null;
  /** Peer file name → the modification time it had when we last read it. */
  seen: Record<string, number>;
  /** The encryption setting `seen` was read under. A change makes every file worth reading again. */
  mode?: "enc" | "plain";
}

async function read<T>(key: string, fallback: T): Promise<T> {
  const r = await browser.storage.local.get(key);
  return (r[key] as T | undefined) ?? fallback;
}

export const getSendTargets = (): Promise<SendTarget[]> => read<SendTarget[]>(KEYS.SEND_TARGETS, []);
export const getSentOut = (): Promise<SentTab[]> => read<SentTab[]>(KEYS.SENT_OUT, []);

/** Put a tab in the outbox. It leaves with the next exchange (the caller usually runs one). */
export async function queueSentTab(to: string, url: string, title: string | undefined, now = Date.now()): Promise<SentTab> {
  if (!sendableUrl(url)) throw new Error("Only web pages (http and https) can be sent to another device.");
  const tab: SentTab = { id: crypto.randomUUID(), to, url, ...(title ? { title } : {}), sent_at: now };
  await updateKey<SentTab[]>(KEYS.SENT_OUT, (cur) => [...(cur ?? []), tab].slice(-MAX_PENDING), []);
  return tab;
}

const e2eeActive = (s: SyncSettings): boolean => !!s.encryption_enabled && !!s.encryption_passphrase;

async function openFile(raw: string, settings: SyncSettings): Promise<{ file: SentTabsFile; payload: SentTabsPayload } | null> {
  let file: SentTabsFile;
  try { file = JSON.parse(raw) as SentTabsFile; } catch { return null; }
  if (!file || typeof file.payload !== "string" || typeof file.device_id !== "string") return null;
  // The same rule as the data packets: an encrypting device does not take plaintext in, and
  // a plaintext device does not decrypt the group's data with a passphrase left in settings.
  if (!!file.encrypted !== e2eeActive(settings)) return null;
  let plain = file.payload;
  if (file.encrypted) {
    try { plain = await decrypt(file.payload, settings.encryption_passphrase as string); }
    catch { return null; }
  }
  if (file.checksum?.length !== 64 || (await sha256(plain)) !== file.checksum) return null;
  try {
    const p = JSON.parse(plain) as Partial<SentTabsPayload>;
    return {
      file,
      payload: {
        sent: Array.isArray(p.sent) ? p.sent.filter((t) => t && typeof t.id === "string" && typeof t.to === "string" && typeof t.url === "string") : [],
        received: Array.isArray(p.received) ? p.received.filter((id) => typeof id === "string") : [],
      },
    };
  } catch {
    return null;
  }
}

async function writeFile(backend: IBackend, settings: SyncSettings, payload: SentTabsPayload, checksum: string): Promise<void> {
  const plain = JSON.stringify(payload);
  const useE2ee = e2eeActive(settings);
  const file: SentTabsFile = {
    version: "1.0",
    device_id: settings.device_id,
    device_label: settings.device_label,
    checksum,
    encrypted: useE2ee,
    payload: useE2ee ? await encrypt(plain, settings.encryption_passphrase as string) : plain,
  };
  await backend.putFile(sentFileName(settings.device_id), JSON.stringify(file));
}

/** Opens arrived tabs. Injected so the exchange can be tested without a browser. */
export type OpenSentTabs = (tabs: SentTab[], from: SendTarget) => Promise<void>;

// One exchange at a time in this worker: a sync and a click on Send can both start one, and
// two writers of the same file could each write a list that lacks the other's change.
let running: Promise<unknown> = Promise.resolve();

/**
 * Read every other device's file, open what was sent here, confirm it, drop what our
 * receivers confirmed, and publish our own file if it changed. Never throws for one bad
 * peer file; a backend failure on our own write does throw, so a Send can report it.
 */
export function exchangeSentTabs(
  backend: IBackend,
  settings: SyncSettings,
  open: OpenSentTabs,
  now = Date.now(),
): Promise<void> {
  const run = running.then(() => exchange(backend, settings, open, now), () => exchange(backend, settings, open, now));
  running = run.catch(() => {});
  return run;
}

async function exchange(backend: IBackend, settings: SyncSettings, open: OpenSentTabs, now: number): Promise<void> {
  const me = settings.device_id;
  if (!me) return;
  const ownName = sentFileName(me);
  const listed = backend.listFilesWithTimes
    ? await backend.listFilesWithTimes(PREFIX)
    : (await backend.listFiles(PREFIX)).map((name) => ({ name, modified: null as number | null }));
  const mode = e2eeActive(settings) ? "enc" : "plain";
  const memory = await read<ExchangeMemory>(KEYS.SENT_SYNC, { written: null, seen: {} });
  if (memory.mode !== mode) memory.seen = {};
  const previousTargets = new Map((await getSendTargets()).map((t) => [t.device_id, t]));
  const opened = await read<Record<string, number>>(KEYS.SENT_OPENED, {});

  const targets: SendTarget[] = [];
  const confirmed = new Set<string>();
  const seen: Record<string, number> = {};
  let ownListed = false;

  for (const { name, modified } of listed) {
    if (name === ownName) { ownListed = true; continue; }
    const m = /^konode_sent_(.+)\.json$/.exec(name);
    if (!m) continue;
    const deviceId = m[1];
    // Unchanged since we last read it: nothing new was sent to us and nothing new was
    // confirmed, so the target we built from it last time still stands.
    if (modified !== null && memory.seen[name] === modified && previousTargets.has(deviceId)) {
      targets.push(previousTargets.get(deviceId)!);
      seen[name] = modified;
      continue;
    }
    let raw: string | null;
    try { raw = await backend.getFile(name); }
    catch (e) {
      logger.warn("SentTabs", `Couldn't read ${name} (${e instanceof Error ? e.message : e}); tabs from that device wait for the next sync`);
      const kept = previousTargets.get(deviceId);
      if (kept) targets.push(kept);
      continue;
    }
    if (!raw) continue;
    const opened_ = await openFile(raw, settings);
    if (!opened_) {
      logger.debug("SentTabs", `Skipping ${name}: unreadable under this device's encryption setting`);
      continue;
    }
    const { file, payload } = opened_;
    const from: SendTarget = { device_id: deviceId, label: typeof file.device_label === "string" && file.device_label ? file.device_label : null };
    targets.push(from);
    if (modified !== null) seen[name] = modified;
    for (const id of payload.received) confirmed.add(id);

    const arrived = payload.sent.filter((t) =>
      t.to === me && !(t.id in opened) && now - (t.sent_at ?? 0) < SENT_TAB_TTL_MS && sendableUrl(t.url));
    if (arrived.length) {
      // Recorded before opening: a tab that fails to open must not be retried every sync.
      for (const t of arrived) opened[t.id] = now;
      await browser.storage.local.set({ [KEYS.SENT_OPENED]: opened });
      try { await open(arrived, from); }
      catch (e) { logger.warn("SentTabs", `Opening ${arrived.length} sent tab(s) failed: ${e instanceof Error ? e.message : e}`); }
      logger.event("SentTabs", `Opened ${arrived.length} tab(s) sent from another device`);
    }
  }

  // Our ids that a receiver confirmed, or that waited too long, leave the outbox.
  const out = await updateKey<SentTab[]>(KEYS.SENT_OUT, (cur) =>
    (cur ?? []).filter((t) => !confirmed.has(t.id) && now - t.sent_at < SENT_TAB_TTL_MS), []);
  for (const [id, at] of Object.entries(opened)) if (now - at >= SENT_TAB_TTL_MS) delete opened[id];
  await browser.storage.local.set({ [KEYS.SENT_OPENED]: opened });

  targets.sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "") || a.device_id.localeCompare(b.device_id));
  await browser.storage.local.set({ [KEYS.SEND_TARGETS]: targets });

  const payload: SentTabsPayload = { sent: out, received: Object.keys(opened).sort() };
  // The label is part of what we publish, so a rename goes out even with nothing else new.
  const checksum = await sha256(JSON.stringify(payload));
  const fingerprint = `${checksum}|${mode}|${settings.device_label ?? ""}`;
  if (fingerprint !== memory.written || !ownListed) {
    await writeFile(backend, settings, payload, checksum);
    memory.written = fingerprint;
  }
  await browser.storage.local.set({ [KEYS.SENT_SYNC]: { written: memory.written, seen, mode } satisfies ExchangeMemory });
}
