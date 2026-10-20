import { TAB_GROUP_COLORS, type SyncSession, type SyncTabGroup, type TabGroupColor } from "@/lib/types";

type TabInfo = { url: string; title?: string; pinned: boolean; favIconUrl?: string; group?: number };
import { logger } from "@/lib/utils/logger";
import { isSafeContentUrl, isSensitiveUrl } from "@/lib/utils/url";
import { browser } from "@/lib/utils/ext";
import { assertDataTypeApi, isIOS, tabGroupSupport } from "@/lib/utils/capabilities";
import { getSingleTabOpenLimit, setSingleTabOpenLimit } from "@/lib/utils/storage";

// ─── Export Current Tabs ──────────────────────────────────────────────────

/**
 * The open tabs worth publishing: plain web pages only, and never one carrying an
 * auth secret. Same rule `exportHistory` already applies.
 *
 * This used to exclude only `chrome://` and `chrome-extension://` by prefix, which
 * still uploaded `file://` (local paths, straight out of the user's disk),
 * `about:` / `moz-extension://` on Firefox, `brave://`, `edge://`, and OAuth callback
 * tabs whose fragment holds a live `#access_token=…` — to third-party storage,
 * unencrypted by default. `importSession` refuses to open every one of those anyway,
 * so this was the most sensitive data we handled, uploaded for no benefit at all.
 */
export async function exportCurrentTabs(): Promise<TabInfo[]> {
  return (await exportOpenTabs()).tabs;
}

/**
 * The publishable tabs, and the groups they sit in (#11).
 *
 * Membership comes from `Tab.groupId`, which needs no permission; names and colours come
 * from `tabGroups.get`, which does, so without it every group goes out as `{}`. Groups are
 * numbered in the order their first tab appears, never by the browser's id, which is a
 * per-run integer that would churn the checksum on every restart. A tab with no group
 * carries no `group` key at all, so a session without groups is exactly what it was before.
 */
export async function exportOpenTabs(): Promise<{ tabs: TabInfo[]; groups?: SyncTabGroup[] }> {
  assertDataTypeApi("sessions");
  const tabs = await browser.tabs.query({});
  const publishable = tabs.filter((t) => isSafeContentUrl(t.url) && !isSensitiveUrl(t.url));
  // Debug-only (never the audit log): a count, never the URLs themselves.
  if (publishable.length !== tabs.length) {
    logger.debug("exportCurrentTabs", `Excluded ${tabs.length - publishable.length} non-web/sensitive tab(s)`);
  }
  const ids: number[] = [];
  const out: TabInfo[] = publishable.map((t) => {
    const info: TabInfo = { url: t.url!, title: t.title, pinned: t.pinned, favIconUrl: t.favIconUrl };
    // -1 is "no group" on both engines; undefined is an engine with no groups at all.
    const gid = (t as { groupId?: number }).groupId;
    if (!t.pinned && typeof gid === "number" && gid >= 0) {
      let at = ids.indexOf(gid);
      if (at < 0) at = ids.push(gid) - 1;
      info.group = at;
    }
    return info;
  });
  if (!ids.length) return { tabs: out };

  const groups: SyncTabGroup[] = ids.map(() => ({}));
  if ((await tabGroupSupport()) === "full") {
    const api = (browser as unknown as { tabGroups: { get(id: number): Promise<{ title?: string; color?: string }> } }).tabGroups;
    for (let i = 0; i < ids.length; i++) {
      try {
        const g = await api.get(ids[i]);
        groups[i] = cleanGroup(g);
      } catch (err) {
        // A group can close between the query and this read. It still goes out, unnamed.
        logger.debug("exportOpenTabs", `Couldn't read a tab group: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return { tabs: out, groups };
}

/** Longest group title kept, in characters. Well past anything a tab strip can show. */
const MAX_GROUP_TITLE = 100;

/**
 * A group as it may be published or applied: a title of plain text within a length, and a
 * colour only from the nine both engines share. Used on the way out, and again on the way
 * in, because a session is a peer's packet and, with E2EE off, anyone who can write to the
 * sync folder can put anything in one.
 */
export function cleanGroup(raw: unknown): SyncTabGroup {
  const g = (raw && typeof raw === "object" ? raw : {}) as { title?: unknown; color?: unknown };
  const out: SyncTabGroup = {};
  if (typeof g.title === "string") {
    // eslint-disable-next-line no-control-regex
    const title = [...g.title.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, MAX_GROUP_TITLE).join("");
    if (title) out.title = title;
  }
  if (typeof g.color === "string" && (TAB_GROUP_COLORS as readonly string[]).includes(g.color)) {
    out.color = g.color as TabGroupColor;
  }
  return out;
}

// ─── Export as Named Session ──────────────────────────────────────────────

export async function exportSession(label?: string): Promise<SyncSession> {
  const { tabs, groups } = await exportOpenTabs();
  return {
    id: crypto.randomUUID(),
    device_id: "", // filled by sync engine
    savedAt: new Date().toISOString(),
    label: label ?? `Session ${new Date().toLocaleDateString()}`,
    tabs,
    ...(groups ? { groups } : {}),
  };
}

// ─── Import (open tabs from a session) ────────────────────────────────────

/**
 * The most tabs one restore will open.
 *
 * A session is a peer's packet, and with E2EE off anyone who can write to the sync folder
 * can put anything in one. Nothing else here bounds the list, so a packet claiming ten
 * thousand tabs would be handed straight to the browser as ten thousand opens. The count
 * is shown in the popup before the click, so this is not the main defence, but "the number
 * you were shown is the number you get" should not depend on the packet being honest.
 * Well above any real session: 200 tabs is already an unusual window.
 */
const MAX_RESTORE_TABS = 200;

export async function importSession(session: SyncSession): Promise<void> {
  assertDataTypeApi("sessions");
  // Never open a non-web URL from a remote packet (javascript:/data:/file: are
  // an injection/exfiltration vector); only http(s) tabs are restored.
  const safe = session.tabs.filter((t) => {
    if (isSafeContentUrl(t.url)) return true;
    logger.warn("importSession", "Skipping an unsafe tab URL");
    return false;
  });
  const openable = safe.slice(0, MAX_RESTORE_TABS);
  if (safe.length > openable.length) {
    logger.warn(
      "importSession",
      `That session lists ${safe.length} tabs, which is more than Konode will open at once. Opening the first ${MAX_RESTORE_TABS}.`
    );
  }

  logger.event("importSession", `Opening ${openable.length} tabs from "${session.label}"`);
  if (openable.length === 0) return;

  /**
   * Restore into the CURRENT window, one tab at a time, on engines that allow it.
   *
   * The history here matters, because both previous versions were half right. 1.0.2
   * replaced the per-tab loop with a single `windows.create({ url: urls })` because
   * WebKit/Orion lets only the FIRST programmatic open through per user gesture, so a
   * 15-tab session restored as one. That fixed WebKit but was applied to every engine,
   * and cost two visible things everywhere: the session landed in a NEW window instead of
   * the one you were in, and `pinned` was dropped, because the url-array form can't carry
   * it. The next version measured the engine instead: open two tabs, count them, fall
   * back to `windows.create` for the rest if the second never appeared.
   *
   * Measuring was the right instinct and the wrong order. WebKit's limit is ONE open per
   * gesture, not one per call, so spending it on tab 0 leaves nothing for the fallback:
   * the rescue window is swallowed exactly like the tab was, and the restore ends with a
   * single tab and no error. Confirmed in the field on Orion, a 10-tab session arriving
   * as 1, while the suite stayed green because a mock blocker has no concept of a user
   * gesture to run out of.
   *
   * So the engine has to be known BEFORE the gesture is spent. We remember what the last
   * restore learned, seed that from the platform on the first one, and only measure when
   * we still have no idea. Being wrong costs one restore and then corrects itself.
   */
  const urls = openable.map((t) => t.url as string);
  // Where each opened tab landed, by its position in `openable`, for the grouping at the
  // end. Grouping opens nothing, so it never spends the one-open-per-click budget.
  const opened: OpenedTab[] = [];
  const openAllInOneWindow = async (list: string[], from: number): Promise<void> => {
    try {
      const win = await browser.windows.create({ url: list, focused: true });
      // Chrome and Firefox both answer with the new window's tabs in URL order. An engine
      // that leaves them out gets asked; one that refuses that too restores ungrouped.
      let tabs = win?.tabs;
      if (!tabs?.length && typeof win?.id === "number") {
        try { tabs = await browser.tabs.query({ windowId: win.id }); } catch { tabs = undefined; }
      }
      tabs?.slice(0, list.length).forEach((t, i) => {
        if (typeof t.id === "number") opened.push({ at: from + i, tabId: t.id, windowId: win?.id });
      });
    } catch (err) {
      logger.error("importSession", err);
    }
  };

  const remembered = await getSingleTabOpenLimit();
  const limited = remembered ?? (await isIOS());
  if (limited) {
    // One gesture, one open: spend it on the call that carries every URL. `pinned` is lost
    // here because the url-array form has nowhere to put it, which is the price of the
    // tabs existing at all on this engine.
    logger.event("importSession", `Opening ${urls.length} tab(s) in one window (this browser allows a single open per click)`);
    await openAllInOneWindow(urls, 0);
    if (remembered === null) await setSingleTabOpenLimit(true);
    await restoreGroups(session.groups, openable, opened);
    return;
  }

  const tabCount = async (): Promise<number> => (await browser.tabs.query({})).length;
  const before = await tabCount();

  for (let i = 0; i < openable.length; i++) {
    const t = openable[i];
    try {
      const tab = await browser.tabs.create({ url: t.url, pinned: t.pinned, active: false });
      if (typeof tab?.id === "number") opened.push({ at: i, tabId: tab.id, windowId: tab.windowId });
    } catch (e) {
      logger.error(`Tab open: ${t.url}`, e);
    }

    // Check once, after the second tab — the first is the one every engine allows, so it
    // proves nothing on its own. Only reachable when we had no stored answer.
    if (i === 1 && (await tabCount()) - before < 2) {
      const rest = openable.slice(1).map((x) => x.url as string);
      // Record BEFORE the rescue attempt: on WebKit the rescue is blocked too, and this
      // flag is the only reason the next restore opens all of them.
      await setSingleTabOpenLimit(true);
      logger.warn(
        "importSession",
        `This browser blocked the second tab, so ${rest.length} tab(s) are opening in their own window instead. If they don't appear, restore again: the next attempt opens them all at once.`
      );
      // The second tab was swallowed, so whatever its create() answered is not a tab.
      for (let k = opened.length - 1; k >= 0; k--) if (opened[k].at >= 1) opened.splice(k, 1);
      await openAllInOneWindow(rest, 1);
      // The first tab stayed in this window and the rest went to a new one, so a group
      // that spans both is restored once per window, never pulled across into one.
      await restoreGroups(session.groups, openable, opened);
      return;
    }
  }

  // Every tab landed where it was asked to, so per-tab restore is safe on this engine and
  // the next restore can skip the measurement.
  if (remembered === null) await setSingleTabOpenLimit(false);
  await restoreGroups(session.groups, openable, opened);
}

/** One tab a restore opened: its position in the session's openable list, and where it is. */
type OpenedTab = { at: number; tabId: number; windowId?: number };

/**
 * Put restored tabs back into their groups (#11). Never fails the restore.
 *
 * Membership needs no permission, so it is restored wherever `tabs.group` exists; the name
 * and colour go on top only where `tabGroups` is held, and otherwise the browser picks the
 * colour (decided 2026-10-02). Everything read from the packet is checked first: the group
 * index has to point at a group, the group goes through `cleanGroup`, and a pinned tab is
 * never grouped, because both engines unpin a tab they group. Tabs are grouped per window,
 * so a restore split across two windows is never pulled back into one.
 *
 * A failure is logged once and leaves the tabs open, ungrouped. Grouping is the extra; the
 * tabs are the restore.
 */
async function restoreGroups(
  rawGroups: unknown,
  tabs: SyncSession["tabs"],
  opened: OpenedTab[],
): Promise<void> {
  if (!Array.isArray(rawGroups) || rawGroups.length === 0 || opened.length === 0) return;
  const support = await tabGroupSupport();
  if (support === "none") return;
  const groups = rawGroups.map(cleanGroup);

  const buckets = new Map<string, { group: number; windowId?: number; tabIds: number[] }>();
  for (const o of opened) {
    const t = tabs[o.at];
    const g = t?.group;
    if (!t || t.pinned || typeof g !== "number" || !Number.isInteger(g) || g < 0 || g >= groups.length) continue;
    const key = `${o.windowId ?? ""}:${g}`;
    const bucket = buckets.get(key) ?? { group: g, windowId: o.windowId, tabIds: [] };
    bucket.tabIds.push(o.tabId);
    buckets.set(key, bucket);
  }
  if (buckets.size === 0) return;

  const api = browser as unknown as {
    tabs: { group(o: { tabIds: number[]; createProperties?: { windowId: number } }): Promise<number> };
    tabGroups?: { update(id: number, p: { title?: string; color?: string }): Promise<unknown> };
  };
  let made = 0;
  let failed = false;
  for (const b of buckets.values()) {
    try {
      const id = await api.tabs.group({
        tabIds: b.tabIds,
        ...(typeof b.windowId === "number" ? { createProperties: { windowId: b.windowId } } : {}),
      });
      made++;
      const { title, color } = groups[b.group];
      if (support === "full" && (title || color)) {
        await api.tabGroups?.update(id, { ...(title ? { title } : {}), ...(color ? { color } : {}) });
      }
    } catch (err) {
      if (!failed) {
        failed = true;
        logger.warn(
          "importSession",
          `Couldn't put the restored tabs back into their groups, so they are open without them: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (made) logger.info("importSession", `Put the restored tabs back into ${made} group(s)`);
}
