/**
 * The browser side of sending tabs (#92): opening what arrived, and the "Send to device"
 * context menu. The exchange itself is lib/sync/sent-tabs.ts.
 */
import type { SentTab, SendTarget } from "@/lib/types";
import { browser, currentStore } from "@/lib/utils/ext";
import { t } from "@/lib/utils/i18n";
import { logger } from "@/lib/utils/logger";
import { KEYS, getSendContextMenu } from "@/lib/utils/storage";
import { isSafeContentUrl } from "@/lib/utils/url";

/**
 * Open tabs another device sent, in the background.
 *
 * In the background so a tab arriving mid-sentence does not take the page away from the
 * user, and without a notification: one for every arrival was more noise than the feature
 * is worth (field test, 2026-11-19), and the tab itself is where the user looks for it.
 */
export async function openSentTabs(tabs: SentTab[]): Promise<void> {
  for (const tab of tabs) {
    try {
      await browser.tabs.create({ url: tab.url, active: false });
    } catch (e) {
      logger.warn("SentTabs", `Couldn't open a tab sent from another device: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** The tabs call `pageToSend` needs, so a test can hand it a fake. */
export type TabsForSend = Pick<typeof chrome.tabs, "query">;

/**
 * The page the popup was opened over, or null when there is none worth sending: the active
 * tab of the popup's window, readable because opening the popup granted activeTab on it.
 *
 * Never another tab, so the popup cannot send a page the user is not looking at. Firefox for
 * Android has no context menus for extensions, so this is its only way to send, and it works
 * there: the real popup (browser menu → Extensions → Konode) sees the page it was opened over
 * and sent it (konode-a15 emulator, Firefox 158.0.2, 2026-11-23). An earlier probe on
 * 2026-11-19 said no page was visible, but it opened the popup as a tab of its own, which is
 * not where Firefox shows it.
 */
export async function pageToSend(tabs: TabsForSend = browser.tabs): Promise<{ url: string; title?: string } | null> {
  const [active] = await tabs.query({ active: true, currentWindow: true });
  return active?.url && isSafeContentUrl(active.url)
    ? { url: active.url, ...(active.title ? { title: active.title } : {}) }
    : null;
}

// ─── Context menu ───────────────────────────────────────────────────────

export const MENU_PARENT = "konode-send";
const MENU_TARGET = "konode-send:";

type MenusApi = typeof chrome.contextMenus;

/** Firefox calls it `menus` (and keeps `contextMenus` as an alias); Firefox for Android has neither. */
export function menusApi(): MenusApi | null {
  const b = browser as unknown as { menus?: MenusApi; contextMenus?: MenusApi };
  const api = b.menus ?? b.contextMenus;
  return api && typeof api.create === "function" ? api : null;
}

/**
 * Rebuild "Send to device ▸" from the current targets. On a page and on a link everywhere,
 * and on a tab's own menu in Firefox, the only engine that has one (Chrome rejects the
 * whole item over an unknown context). With `enabled` off (Settings, Device) the menu is
 * only cleared, so nothing of Konode's is left in it, and the same goes while no device can
 * receive: until 1.7.0 the entry held one greyed-out "no device" item, which every
 * one-device install and every unconfigured one carried in each right-click menu for
 * nothing. The popup's paper plane already showed only with a target.
 */
export async function rebuildSendMenu(targets: SendTarget[], enabled = true): Promise<void> {
  const menus = menusApi();
  if (!menus) return;
  const contexts = (currentStore() === "firefox" ? ["page", "link", "tab"] : ["page", "link"]) as chrome.contextMenus.ContextType[];
  const create = (props: chrome.contextMenus.CreateProperties): Promise<void> =>
    new Promise((resolve) => {
      // The callback form, because the promise form is not on every engine, and an error
      // here (a duplicate id from two rebuilds racing) must not escape as an unhandled one.
      menus.create(props, () => { void browser.runtime.lastError; resolve(); });
    });
  try {
    await menus.removeAll();
    if (!enabled || !targets.length) return;
    await create({ id: MENU_PARENT, title: t("send_menu_title"), contexts });
    for (const target of targets) {
      await create({
        id: `${MENU_TARGET}${target.device_id}`,
        parentId: MENU_PARENT,
        title: target.label ?? t("popup_unknown_device"),
        contexts,
      });
    }
  } catch (e) {
    logger.warn("SentTabs", `Couldn't build the Send to device menu: ${e instanceof Error ? e.message : e}`);
  }
}

let menuQueue: Promise<void> = Promise.resolve();

/**
 * Rebuild the menu from what storage holds now: the targets and the Settings switch. One
 * rebuild at a time, each reading storage when its turn comes. Two that overlapped could
 * interleave their removeAll and creates, so a switch turned off just as the targets changed
 * could be followed by the other rebuild putting the menu back.
 */
export function refreshSendMenu(): Promise<void> {
  menuQueue = menuQueue
    .then(async () => {
      // Read here rather than through lib/sync/sent-tabs' getSendTargets: the popup imports
      // this file, and that one would bring the crypto module into the popup for one read.
      const stored = await browser.storage.local.get(KEYS.SEND_TARGETS);
      const targets = (stored[KEYS.SEND_TARGETS] ?? []) as SendTarget[];
      await rebuildSendMenu(targets, await getSendContextMenu());
    })
    .catch((e) => logger.warn("SentTabs", `Couldn't refresh the Send to device menu: ${e instanceof Error ? e.message : e}`));
  return menuQueue;
}

/** What a click on a menu item asks to send, or null when it is not one of ours. */
export function sendRequestFromMenu(
  info: { menuItemId: string | number; linkUrl?: string; linkText?: string; pageUrl?: string },
  tab?: { url?: string; title?: string },
): { to: string; url: string; title?: string } | null {
  const id = String(info.menuItemId);
  if (!id.startsWith(MENU_TARGET)) return null;
  const to = id.slice(MENU_TARGET.length);
  if (info.linkUrl) return { to, url: info.linkUrl, ...(info.linkText ? { title: info.linkText } : {}) };
  const url = tab?.url || info.pageUrl;
  if (!url) return null;
  return { to, url, ...(tab?.title ? { title: tab.title } : {}) };
}
