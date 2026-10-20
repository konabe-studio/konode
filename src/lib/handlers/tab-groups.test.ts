import { describe, it, expect, afterEach } from "vitest";
import { cleanGroup, exportOpenTabs, exportSession, importSession } from "@/lib/handlers/tabs-handler";
import {
  permissionsToEnable, resetCapabilityCache, tabGroupSupport, tabGroupsAskable,
} from "@/lib/utils/capabilities";
import { setSingleTabOpenLimit } from "@/lib/utils/storage";
import type { SyncSession } from "@/lib/types";

// Tab groups in the open-tabs session (#11). Uses the tabs/tabGroups/windows fakes in
// test/setup.ts, which carry groupId and windowId the way both engines do.

/* eslint-disable @typescript-eslint/no-explicit-any */
const tabs = chrome.tabs as any;
const tabGroups = () => (chrome as any).tabGroups as {
  update(id: number, p: object): Promise<unknown>;
  __groups(): Array<{ id: number; title: string; color: string; windowId: number }>;
};
const realGroup = tabs.group;
const realTabGroups = (chrome as any).tabGroups;
const realContains = chrome.permissions.contains;

afterEach(() => {
  tabs.group = realGroup;
  (chrome as any).tabGroups = realTabGroups;
  (chrome.permissions as any).contains = realContains;
  resetCapabilityCache();
});

/** Hold every permission but `tabGroups`, as a browser where it was never granted. */
function withoutTabGroupsPermission(): void {
  (chrome.permissions as any).contains = (req: { permissions?: string[] }) =>
    Promise.resolve(!req.permissions?.includes("tabGroups"));
}

/** An engine with no groups at all (Firefox for Android, Safari, Firefox before 138). */
function withoutGroups(): void {
  delete tabs.group;
  delete (chrome as any).tabGroups;
}

async function open(url: string, pinned = false): Promise<number> {
  return (await chrome.tabs.create({ url, pinned })).id!;
}

describe("publishing groups with the session", () => {
  it("numbers groups by first appearance and names them where tabGroups is held", async () => {
    const a = await open("https://a.example/");
    const b = await open("https://b.example/");
    const c = await open("https://c.example/");
    const d = await open("https://d.example/");
    const work = await tabs.group({ tabIds: [b, d] });
    await tabGroups().update(work, { title: "Work", color: "blue" });
    await tabs.group({ tabIds: [c] }); // untitled, the browser's grey
    void a;

    const out = await exportOpenTabs();
    expect(out.tabs.map((t) => t.group)).toEqual([undefined, 0, 1, 0]);
    expect(out.groups).toEqual([{ title: "Work", color: "blue" }, { color: "grey" }]);
  });

  it("carries membership alone without the permission, and no names", async () => {
    withoutTabGroupsPermission();
    const a = await open("https://a.example/");
    const b = await open("https://b.example/");
    const id = await tabs.group({ tabIds: [a, b] });
    await tabGroups().update(id, { title: "Secret project", color: "red" });

    const out = await exportOpenTabs();
    expect(out.tabs.map((t) => t.group)).toEqual([0, 0]);
    expect(out.groups).toEqual([{}]);
  });

  it("leaves a session without groups exactly as it was, so no checksum moves on the upgrade", async () => {
    await open("https://a.example/");
    await open("https://b.example/");

    const session = await exportSession("x");
    expect(session).not.toHaveProperty("groups");
    expect(session.tabs.every((t) => !("group" in t))).toBe(true);
  });

  it("publishes nothing about groups on an engine without them", async () => {
    withoutGroups();
    await open("https://a.example/");
    const out = await exportOpenTabs();
    expect(out.groups).toBeUndefined();
    expect(out.tabs[0]).not.toHaveProperty("group");
  });

  it("does not let an excluded tab leave a group behind", async () => {
    const a = await open("chrome://settings");
    const b = await open("https://b.example/");
    await tabs.group({ tabIds: [a] });
    void b;
    const out = await exportOpenTabs();
    expect(out.tabs.map((t) => t.url)).toEqual(["https://b.example/"]);
    expect(out.groups).toBeUndefined();
  });
});

function session(list: Array<{ url: string; group?: number; pinned?: boolean }>, groups?: unknown): SyncSession {
  return {
    id: "s1", device_id: "peer", savedAt: "", label: "Peer",
    tabs: list.map((t) => ({ url: t.url, pinned: !!t.pinned, ...(t.group !== undefined ? { group: t.group } : {}) })),
    ...(groups !== undefined ? { groups: groups as SyncSession["groups"] } : {}),
  };
}

const openNow = async () => (await chrome.tabs.query({})).map((t: any) => ({ url: t.url, groupId: t.groupId, pinned: t.pinned }));

describe("restoring groups", () => {
  it("puts the tabs back into their groups, named and coloured, in this window", async () => {
    await setSingleTabOpenLimit(false);
    await importSession(session(
      [{ url: "https://a.example/" }, { url: "https://b.example/", group: 0 }, { url: "https://c.example/", group: 1 }, { url: "https://d.example/", group: 0 }],
      [{ title: "Work", color: "blue" }, { title: "Reading", color: "green" }],
    ));

    const now = await openNow();
    expect(now.map((t) => t.url)).toEqual(["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"]);
    expect(now[0].groupId).toBe(-1);
    expect(now[1].groupId).toBe(now[3].groupId);
    expect(now[2].groupId).not.toBe(now[1].groupId);
    const byId = new Map(tabGroups().__groups().map((g) => [g.id, g]));
    expect(byId.get(now[1].groupId)).toMatchObject({ title: "Work", color: "blue", windowId: 1 });
    expect(byId.get(now[2].groupId)).toMatchObject({ title: "Reading", color: "green" });
  });

  it("restores membership without names where tabGroups is not held", async () => {
    await setSingleTabOpenLimit(false);
    withoutTabGroupsPermission();
    await importSession(session([{ url: "https://a.example/", group: 0 }, { url: "https://b.example/", group: 0 }], [{ title: "Work", color: "blue" }]));

    const now = await openNow();
    expect(now[0].groupId).toBeGreaterThanOrEqual(0);
    expect(now[0].groupId).toBe(now[1].groupId);
    expect(tabGroups().__groups()[0]).toMatchObject({ title: "", color: "grey" }); // the browser's pick
  });

  it("restores ungrouped, and quietly, on an engine without groups", async () => {
    await setSingleTabOpenLimit(false);
    withoutGroups();
    await importSession(session([{ url: "https://a.example/", group: 0 }], [{ title: "Work" }]));
    expect((await openNow()).map((t) => t.url)).toEqual(["https://a.example/"]);
  });

  it("checks everything a hostile packet could put in", async () => {
    await setSingleTabOpenLimit(false);
    await importSession(session(
      [
        { url: "https://a.example/", group: 0 },
        { url: "https://b.example/", group: 7 },            // points past the list
        { url: "https://c.example/", group: 0, pinned: true }, // a pinned tab is never grouped
        { url: "https://d.example/", group: 1 },
      ],
      [{ title: "x\u0000\u001fy" + "z".repeat(500), color: "magenta" }, "not a group"],
    ));

    const now = await openNow();
    expect(now[1].groupId).toBe(-1);
    expect(now[2]).toMatchObject({ groupId: -1, pinned: true });
    const first = tabGroups().__groups().find((g) => g.id === now[0].groupId)!;
    expect(first.title).toBe(("xy" + "z".repeat(500)).slice(0, 100));
    expect(first.color).toBe("grey"); // magenta is not one of the nine
    expect(now[3].groupId).toBeGreaterThanOrEqual(0); // an invalid entry still groups, unnamed
  });

  it("survives a groups field that is not a list at all", async () => {
    await setSingleTabOpenLimit(false);
    await importSession(session([{ url: "https://a.example/", group: 0 }], { evil: true }));
    expect((await openNow())).toEqual([{ url: "https://a.example/", groupId: -1, pinned: false }]);
  });

  it("keeps the tabs when grouping fails", async () => {
    await setSingleTabOpenLimit(false);
    tabs.group = () => Promise.reject(new Error("the browser said no"));
    await importSession(session([{ url: "https://a.example/", group: 0 }, { url: "https://b.example/", group: 0 }], [{ title: "Work" }]));
    expect((await openNow()).map((t) => t.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("groups inside the new window on the one-open-per-click path", async () => {
    await setSingleTabOpenLimit(true);
    await importSession(session([{ url: "https://a.example/", group: 0 }, { url: "https://b.example/", group: 0 }, { url: "https://c.example/" }], [{ title: "Work", color: "cyan" }]));

    const now = await openNow();
    expect(now[0].groupId).toBe(now[1].groupId);
    expect(now[2].groupId).toBe(-1);
    expect(tabGroups().__groups()[0]).toMatchObject({ title: "Work", color: "cyan", windowId: 2 });
  });
});

describe("cleanGroup", () => {
  it("keeps a plain title and one of the nine colours", () => {
    expect(cleanGroup({ title: " Work ", color: "purple" })).toEqual({ title: "Work", color: "purple" });
  });
  it("drops what is not text or not a shared colour", () => {
    expect(cleanGroup({ title: 42, color: "gray" })).toEqual({});
    expect(cleanGroup(null)).toEqual({});
  });
});

describe("what the browser can do with groups", () => {
  it("is full with the permission, membership without it, none without tabs.group", async () => {
    expect(await tabGroupSupport()).toBe("full");
    withoutTabGroupsPermission();
    expect(await tabGroupSupport()).toBe("membership");
    withoutGroups();
    expect(await tabGroupSupport()).toBe("none");
  });

  it("asks for tabGroups only where the browser knows the permission", async () => {
    expect(await tabGroupsAskable()).toBe(true);
    resetCapabilityCache();
    // Firefox 138: tabs.group is there, the permission is not, and contains() throws for it.
    (chrome.permissions as any).contains = () => Promise.reject(new Error("Type error for parameter permissions"));
    expect(await tabGroupsAskable()).toBe(false);
    resetCapabilityCache();
    withoutGroups();
    expect(await tabGroupsAskable()).toBe(false);
  });

  it("adds tabGroups to the Open tabs request, and only there", () => {
    expect(permissionsToEnable("sessions", true)).toEqual(["tabs", "tabGroups"]);
    expect(permissionsToEnable("sessions", false)).toEqual(["tabs"]);
    expect(permissionsToEnable("history", true)).toEqual(["history"]);
    expect(permissionsToEnable("bookmarks", true)).toEqual([]);
  });
});
