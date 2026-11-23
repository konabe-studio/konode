import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IBackend, SentTab, SendTarget, SyncSettings } from "@/lib/types";
import { DEFAULT_SETTINGS, KEYS, sendContextMenuOn } from "@/lib/utils/storage";
import {
  exchangeSentTabs, queueSentTab, getSendTargets, getSentOut, sentFileName, SENT_TAB_TTL_MS,
} from "@/lib/sync/sent-tabs";
import {
  sendRequestFromMenu, pageToSend, rebuildSendMenu, refreshSendMenu, MENU_PARENT, type TabsForSend,
} from "@/lib/sent-tabs-browser";

// Send to device (#92): every device publishes konode_sent_<id>.json; a receiver opens what
// was sent to it on its next exchange and confirms it, and the sender then drops it.

/** One shared folder. `times` gives the listing modification times, as WebDAV and Drive do. */
class Folder {
  files = new Map<string, { content: string; modified: number }>();
  puts: string[] = [];
  reads: string[] = [];
  private clock = 1;
  constructor(private times = true) {}
  backend(): IBackend {
    const b = {
      putFile: async (name: string, content: string) => { this.puts.push(name); this.files.set(name, { content, modified: this.clock++ }); },
      getFile: async (name: string) => { this.reads.push(name); return this.files.get(name)?.content ?? null; },
      listFiles: async (prefix: string) => [...this.files.keys()].filter((n) => n.startsWith(prefix)),
      deleteFile: async (name: string) => { this.files.delete(name); },
    } as unknown as IBackend;
    if (this.times) {
      (b as { listFilesWithTimes?: unknown }).listFilesWithTimes = async (prefix: string) =>
        [...this.files].filter(([n]) => n.startsWith(prefix)).map(([name, f]) => ({ name, modified: f.modified }));
    }
    return b;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = (globalThis as any).__konodeDevices;
/* eslint-enable @typescript-eslint/no-explicit-any */
const saved = new Map<string, unknown>();
let current: string | null = null;
/** Run `fn` as device `id`: its own storage, swapped in. */
async function as<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (current !== id) {
    if (current) saved.set(current, D.snapshot());
    if (saved.has(id)) D.restore(saved.get(id)); else D.fresh(id.charCodeAt(0) * 1000);
    current = id;
  }
  return fn();
}

const settings = (id: string, extra: Partial<SyncSettings> = {}): SyncSettings =>
  ({ ...DEFAULT_SETTINGS, device_id: id, device_label: `Device ${id}`, ...extra });

/** An exchange that records what it was asked to open instead of opening it. */
function exchange(folder: Folder, s: SyncSettings, now = Date.now()) {
  const opened: Array<{ tabs: SentTab[]; from: SendTarget }> = [];
  return exchangeSentTabs(folder.backend(), s, async (tabs, from) => { opened.push({ tabs, from }); }, now)
    .then(() => opened);
}

beforeEach(() => {
  saved.clear();
  current = null;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("sending a tab to another device (#92)", () => {
  it("delivers a tab, confirms it, and the sender then drops it", async () => {
    const folder = new Folder();
    const A = settings("A"), B = settings("B");
    await as("A", () => exchange(folder, A));
    await as("B", () => exchange(folder, B));
    await as("A", () => exchange(folder, A)); // A now sees B

    expect(await as("A", getSendTargets)).toEqual([{ device_id: "B", label: "Device B" }]);
    const sent = await as("A", () => queueSentTab("B", "https://example.com/article", "An article"));
    await as("A", () => exchange(folder, A));

    const arrived = await as("B", () => exchange(folder, B));
    expect(arrived).toHaveLength(1);
    expect(arrived[0].tabs.map((t) => t.url)).toEqual(["https://example.com/article"]);
    expect(arrived[0].from).toEqual({ device_id: "A", label: "Device A" });

    await as("A", () => exchange(folder, A));
    expect(await as("A", getSentOut)).toEqual([]);
    expect(sent.id).toBeTruthy();
  });

  it("opens a tab once, however many syncs see it", async () => {
    const folder = new Folder(false); // no listing times: every file is read every time
    const A = settings("A"), B = settings("B");
    await as("A", () => exchange(folder, A));
    await as("B", () => exchange(folder, B));
    await as("A", () => queueSentTab("B", "https://example.com/once", undefined));
    await as("A", () => exchange(folder, A));

    const first = await as("B", () => exchange(folder, B));
    const second = await as("B", () => exchange(folder, B));
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("does not offer a device that publishes no sent-tabs file, such as one on an older build", async () => {
    const folder = new Folder();
    folder.files.set("konode_bookmarks_OLD.json", { content: "{}", modified: 1 });
    await as("A", () => exchange(folder, settings("A")));
    expect(await as("A", getSendTargets)).toEqual([]);
  });

  it("never opens a non-web address, even one a peer's file carries", async () => {
    const folder = new Folder();
    const B = settings("B");
    await as("B", () => exchange(folder, B));
    // A hand-written peer file, as a tampered or buggy one would be.
    const payload = JSON.stringify({ sent: [{ id: "x", to: "B", url: "javascript:alert(1)", sent_at: Date.now() }], received: [] });
    const { sha256 } = await import("@/lib/crypto/encryption");
    folder.files.set(sentFileName("EVIL"), {
      content: JSON.stringify({ version: "1.0", device_id: "EVIL", checksum: await sha256(payload), encrypted: false, payload }),
      modified: 99,
    });
    expect(await as("B", () => exchange(folder, B))).toEqual([]);
    await expect(as("B", () => queueSentTab("A", "file:///etc/passwd", undefined))).rejects.toThrow();
  });

  it("ignores a peer file whose checksum does not match its payload", async () => {
    const folder = new Folder();
    const B = settings("B");
    const payload = JSON.stringify({ sent: [{ id: "x", to: "B", url: "https://example.com/", sent_at: Date.now() }], received: [] });
    folder.files.set(sentFileName("A"), {
      content: JSON.stringify({ version: "1.0", device_id: "A", checksum: "0".repeat(64), encrypted: false, payload }),
      modified: 1,
    });
    expect(await as("B", () => exchange(folder, B))).toEqual([]);
    expect(await as("B", getSendTargets)).toEqual([]);
  });

  it("lets a tab expire when its receiver never comes back", async () => {
    const folder = new Folder();
    const A = settings("A"), B = settings("B");
    await as("A", () => exchange(folder, A));
    await as("B", () => exchange(folder, B));
    const t0 = Date.now();
    await as("A", () => queueSentTab("B", "https://example.com/late", undefined, t0));
    await as("A", () => exchange(folder, A, t0));

    expect(await as("B", () => exchange(folder, B, t0 + SENT_TAB_TTL_MS + 1))).toEqual([]);
    await as("A", () => exchange(folder, A, t0 + SENT_TAB_TTL_MS + 1));
    expect(await as("A", getSentOut)).toEqual([]);
  });

  it("does not rewrite its own file when nothing changed", async () => {
    const folder = new Folder();
    const A = settings("A"), B = settings("B");
    await as("A", () => exchange(folder, A));
    await as("B", () => exchange(folder, B));
    await as("A", () => exchange(folder, A));
    folder.puts = [];

    await as("A", () => exchange(folder, A));
    expect(folder.puts).toEqual([]);
    expect(await as("A", getSendTargets)).toEqual([{ device_id: "B", label: "Device B" }]);
  });

  it("still finds a tab written in the same second as its last read", async () => {
    // WebDAV lists times to the second. A's second Send lands in the second B read A's file
    // after the first one, so the listed time does not move; trusting it at once lost the
    // second tab until A's file changed again.
    const folder = new Folder();
    const A = settings("A"), B = settings("B");
    await as("A", () => exchange(folder, A));
    await as("B", () => exchange(folder, B));
    await as("A", () => queueSentTab("B", "https://example.com/first", undefined));
    await as("A", () => exchange(folder, A));
    const stamp = folder.files.get(sentFileName("A"))!.modified;
    await as("B", () => exchange(folder, B)); // reads A's file within that second
    await as("A", () => queueSentTab("B", "https://example.com/second", undefined));
    await as("A", () => exchange(folder, A));
    folder.files.get(sentFileName("A"))!.modified = stamp; // still the same second, as WebDAV lists it

    const arrived = await as("B", () => exchange(folder, B));
    expect(arrived.flatMap((x) => x.tabs.map((t) => t.url))).toEqual(["https://example.com/second"]);
  });

  it("publishes a rename even with nothing else new", async () => {
    const folder = new Folder();
    await as("A", () => exchange(folder, settings("A")));
    folder.puts = [];
    await as("A", () => exchange(folder, settings("A", { device_label: "Work laptop" })));
    expect(folder.puts).toEqual([sentFileName("A")]);
  });

  it("travels encrypted between devices that share a passphrase, and not to one that does not", async () => {
    const folder = new Folder();
    const enc = { encryption_enabled: true, encryption_passphrase: "correct horse battery staple" };
    const A = settings("A", enc), B = settings("B", enc);
    const C = settings("C", { encryption_enabled: true, encryption_passphrase: "a different passphrase entirely" });
    const P = settings("P"); // plaintext
    for (const [id, s] of [["A", A], ["B", B], ["C", C], ["P", P]] as const) await as(id, () => exchange(folder, s));
    await as("A", () => exchange(folder, A));

    expect((await as("A", getSendTargets)).map((t) => t.device_id)).toEqual(["B"]);
    const raw = JSON.parse(folder.files.get(sentFileName("A"))!.content);
    expect(raw.encrypted).toBe(true);
    expect(raw.payload).not.toContain("received");

    await as("A", () => queueSentTab("B", "https://example.com/secret", undefined));
    await as("A", () => exchange(folder, A));
    expect(await as("B", () => exchange(folder, B))).toHaveLength(1);
  });

  it("keeps the outbox through a failed write, so the next exchange still sends it", async () => {
    const folder = new Folder();
    const A = settings("A");
    await as("A", () => queueSentTab("B", "https://example.com/retry", undefined));
    const broken = { ...folder.backend(), putFile: async () => { throw new Error("offline"); } } as IBackend;
    await expect(as("A", () => exchangeSentTabs(broken, A, async () => {}))).rejects.toThrow("offline");
    expect(await as("A", getSentOut)).toHaveLength(1);
    const stored = (await as("A", () => chrome.storage.local.get(KEYS.SENT_OUT)))[KEYS.SENT_OUT];
    expect(stored).toHaveLength(1);
  });
});

describe("the Send to device menu", () => {
  it("sends the link for a click on a link, and the page otherwise", () => {
    expect(sendRequestFromMenu(
      { menuItemId: "konode-send:B", linkUrl: "https://example.com/l", linkText: "A link", pageUrl: "https://example.com/" },
      { url: "https://example.com/", title: "Page" },
    )).toEqual({ to: "B", url: "https://example.com/l", title: "A link" });
    expect(sendRequestFromMenu(
      { menuItemId: "konode-send:B", pageUrl: "https://example.com/" },
      { url: "https://example.com/p", title: "Page" },
    )).toEqual({ to: "B", url: "https://example.com/p", title: "Page" });
    expect(sendRequestFromMenu({ menuItemId: "something-else" })).toBeNull();
  });
});

describe("taking Send to device out of the right-click menu", () => {
  /**
   * A context menu API that keeps its items by id and logs every call, installed as
   * `contextMenus` on the fake browser (the test setup has none). A create answers through
   * its callback a macrotask later, as a real one does after a round trip to the browser.
   */
  function installMenus() {
    const items = new Map<string, chrome.contextMenus.CreateProperties>();
    const calls: string[] = [];
    let created!: () => void;
    const firstCreate = new Promise<void>((r) => { created = r; });
    const api = {
      create: (props: chrome.contextMenus.CreateProperties, cb?: () => void) => {
        calls.push(`create ${props.id}`);
        items.set(String(props.id), props);
        created();
        setTimeout(() => cb?.(), 0);
      },
      removeAll: async () => { calls.push("removeAll"); items.clear(); },
      onClicked: { addListener: () => {} },
    };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (globalThis as any).chrome.contextMenus = api;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { items, calls, firstCreate };
  }
  afterEach(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    delete (globalThis as any).chrome.contextMenus;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  const targets: SendTarget[] = [{ device_id: "B", label: "Device B" }, { device_id: "C", label: "Device C" }];
  const store = (s: Partial<SyncSettings>, t: SendTarget[] = targets) =>
    chrome.storage.local.set({ [KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, ...s }, [KEYS.SEND_TARGETS]: t });

  it("is on unless the switch says false, so settings from 1.6.0 keep the menu", () => {
    expect(sendContextMenuOn(undefined)).toBe(true);
    expect(sendContextMenuOn({})).toBe(true);
    expect(sendContextMenuOn({ send_context_menu: true })).toBe(true);
    expect(sendContextMenuOn({ send_context_menu: false })).toBe(false);
  });

  it("builds the entry with one item per device while the switch is on", async () => {
    const { items } = installMenus();
    await rebuildSendMenu(targets, true);
    expect([...items.keys()]).toEqual([MENU_PARENT, "konode-send:B", "konode-send:C"]);
  });

  it("leaves nothing of Konode's in the menu when the switch is off, and puts it back when on", async () => {
    const { items, calls } = installMenus();
    await rebuildSendMenu(targets, true);
    await rebuildSendMenu(targets, false);
    expect(items.size).toBe(0);
    expect(calls.at(-1)).toBe("removeAll");
    await rebuildSendMenu(targets, true);
    expect([...items.keys()]).toEqual([MENU_PARENT, "konode-send:B", "konode-send:C"]);
  });

  it("reads the switch and the targets from storage", async () => {
    await as("A", async () => {
      const { items } = installMenus();
      await store({ send_context_menu: false });
      await refreshSendMenu();
      expect(items.size).toBe(0);
      await store({});
      await refreshSendMenu();
      expect([...items.keys()]).toEqual([MENU_PARENT, "konode-send:B", "konode-send:C"]);
    });
  });

  it("does not let a rebuild still creating items put the menu back after the switch went off", async () => {
    await as("A", async () => {
      const { items, calls, firstCreate } = installMenus();
      await store({});
      const first = refreshSendMenu();
      await firstCreate; // mid-build: the parent is there, the devices are not yet
      await store({ send_context_menu: false });
      const second = refreshSendMenu();
      await Promise.all([first, second]);
      expect(items.size).toBe(0);
      // The second rebuild began only once the first had finished.
      expect(calls).toEqual(["removeAll", `create ${MENU_PARENT}`, "create konode-send:B", "create konode-send:C", "removeAll"]);
    });
  });
});

describe("the page the popup sends", () => {
  const tab = (id: number, url: string | undefined, extra: Partial<chrome.tabs.Tab> = {}) =>
    ({ id, url, title: `T${id}`, active: false, windowId: 1, ...extra }) as chrome.tabs.Tab;
  /** A tabs API over fixed windows; the popup's window is window 1. */
  const fake = (all: chrome.tabs.Tab[]): TabsForSend => ({
    query: (async (q: chrome.tabs.QueryInfo) =>
      all.filter((t) => (!q.active || t.active) && (!q.currentWindow || t.windowId === 1))) as TabsForSend["query"],
  });

  it("is the active tab of the popup's window", async () => {
    const all = [tab(1, "https://a.example/"), tab(2, "https://b.example/", { active: true })];
    expect(await pageToSend(fake(all))).toEqual({ url: "https://b.example/", title: "T2" });
  });

  it("is nothing when that tab is not a web page, never another window's tab", async () => {
    const all = [tab(1, "chrome://newtab/", { active: true }), tab(2, "https://other.example/", { active: true, windowId: 2 })];
    expect(await pageToSend(fake(all))).toBeNull();
  });

  it("is nothing where the popup sees only itself, as on Firefox for Android", async () => {
    expect(await pageToSend(fake([tab(9, "about:blank", { active: true })]))).toBeNull();
  });
});
