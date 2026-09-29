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
  c.windows.create = windowsCreate;
});

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
