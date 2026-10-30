import { describe, it, expect, vi, afterEach } from "vitest";
import { openConflictFromNotification, notifyConflict } from "@/lib/sync/conflict-resolver";

// The conflict toast says "Open Konode to resolve it", and clicking it did nothing: nothing
// listened for the click (QA step H, 2026-08-28). Conflicts are answered in the popup.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = chrome as any;

function stub(openPopup?: () => Promise<void>): { clear: ReturnType<typeof vi.fn> } {
  const clear = vi.fn(() => Promise.resolve(true));
  c.notifications.clear = clear;
  c.runtime.getURL = (p: string) => `chrome-extension://test-extension-id/${p}`;
  c.action.openPopup = openPopup;
  return { clear };
}
/** Everything the click put on screen: pages in tabs, and pages in windows of their own. */
const opened = async (): Promise<string[]> =>
  ((await chrome.tabs.query({})) as { url?: string }[]).map((t) => t.url ?? "");
const windows = (): Array<{ urls: string[]; focused: boolean }> => c.windows.__created();

const windowsCreate = c.windows.create;
afterEach(() => {
  delete c.action.openPopup;
  delete c.notifications.clear;
  delete c.runtime.getURL;
  delete c.windows.getLastFocused;
  delete c.windows.update;
  c.windows.create = windowsCreate;
});

/**
 * A browser window as Chrome keeps it, and an openPopup that behaves as Chrome's does: it
 * refuses a window that is not active. `focused` starts false, as it is when the click
 * landed on the system's toast.
 */
function chromeWindow(id = 7): { calls: string[] } {
  const calls: string[] = [];
  const win = { id, focused: false };
  c.windows.getLastFocused = vi.fn(() => Promise.resolve({ ...win }));
  c.windows.update = vi.fn((wid: number, props: { focused?: boolean }) => {
    calls.push(`update ${wid}`);
    if (wid === win.id && props.focused) win.focused = true;
    return Promise.resolve({ ...win });
  });
  c.action.openPopup = vi.fn((opts?: { windowId?: number }) => {
    calls.push(`openPopup ${opts?.windowId}`);
    const target = opts?.windowId ?? win.id;
    return target === win.id && win.focused
      ? Promise.resolve()
      : Promise.reject(new Error("Cannot show popup for an inactive window."));
  });
  return { calls };
}

describe("clicking the conflict notification", () => {
  it("opens the popup where the browser lets an extension do that", async () => {
    const openPopup = vi.fn(() => Promise.resolve());
    const { clear } = stub(openPopup);

    expect(await openConflictFromNotification("conflict-1790000000000")).toBe(true);

    expect(openPopup).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith("conflict-1790000000000");
    expect(await opened()).toEqual([]);
    expect(windows()).toEqual([]);
  });

  it("opens the popup's page in a small window when the browser will not open the popup", async () => {
    // Chromium with no focused window, or Firefox outside a user action it recognises.
    stub(() => Promise.reject(new Error("Could not find an active browser window.")));

    expect(await openConflictFromNotification("conflict-1790000000000")).toBe(true);

    expect(windows()).toEqual([
      expect.objectContaining({ urls: ["chrome-extension://test-extension-id/popup.html"], focused: true }),
    ]);
  });

  it("does the same on a browser without openPopup", async () => {
    stub(undefined);

    await openConflictFromNotification("conflict-1790000000000");

    expect(windows().map((w) => w.urls)).toEqual([["chrome-extension://test-extension-id/popup.html"]]);
  });

  it("opens a tab where there are no windows to open (Firefox for Android)", async () => {
    stub(undefined);
    c.windows.create = undefined;

    await openConflictFromNotification("conflict-1790000000000");

    expect(await opened()).toEqual(["chrome-extension://test-extension-id/popup.html"]);
  });

  it("brings the browser window to the front first, since Chrome opens no popup in an inactive one", async () => {
    // QA step AL, Chrome on Windows: the toast is the system's own, so clicking it takes the
    // focus, and every click opened the small window even with the browser in front.
    stub();
    const { calls } = chromeWindow(7);

    expect(await openConflictFromNotification("conflict-1790000000000")).toBe(true);

    expect(calls).toEqual(["update 7", "openPopup 7"]);
    expect(windows()).toEqual([]);
    expect(await opened()).toEqual([]);
  });

  it("still opens the small window when no browser window can be found to focus", async () => {
    // Every window closed, the browser still running in the background.
    stub();
    chromeWindow();
    c.windows.getLastFocused = vi.fn(() => Promise.reject(new Error("No last-focused window")));

    expect(await openConflictFromNotification("conflict-1790000000000")).toBe(true);

    expect(c.windows.update).not.toHaveBeenCalled();
    expect(windows().map((w) => w.urls)).toEqual([["chrome-extension://test-extension-id/popup.html"]]);
  });

  it("leaves a notification that is not a conflict alone", async () => {
    const openPopup = vi.fn(() => Promise.resolve());
    const { clear } = stub(openPopup);

    expect(await openConflictFromNotification("something-else")).toBe(false);

    expect(openPopup).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(await opened()).toEqual([]);
  });

  it("recognises the notifications notifyConflict makes", async () => {
    notifyConflict("bookmarks");
    const id = c.notifications.create.mock.calls.at(-1)[0] as string;
    const openPopup = vi.fn(() => Promise.resolve());
    stub(openPopup);

    expect(await openConflictFromNotification(id)).toBe(true);
    expect(openPopup).toHaveBeenCalledOnce();
  });
});
