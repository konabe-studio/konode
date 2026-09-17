import { describe, it, expect } from "vitest";
import { restoreBookmarks } from "@/lib/handlers/bookmarks-handler";
import { setTombstones, getTombstones } from "@/lib/utils/storage";
import type { SyncBookmark } from "@/lib/types";

// restoreBookmarks is additive: it brings back what is missing and leaves what is there. #29
// was about where the missing things went. Every create appended, so on a parent where
// anything had survived, everything restored landed after it, out of its old order.

function snapshot(barChildren: SyncBookmark[]): SyncBookmark[] {
  return [{
    id: "0", parentId: null, title: "", dateAdded: 0,
    children: [
      { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, children: barChildren },
      { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
      { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
    ],
  }];
}

const link = (title: string): SyncBookmark =>
  ({ id: `s-${title}`, parentId: "1", title, url: `https://${title.toLowerCase()}.com`, dateAdded: 1 });
const folder = (title: string, children: SyncBookmark[]): SyncBookmark =>
  ({ id: `s-folder-${title}`, parentId: "1", title, dateAdded: 1, children });

async function seedLink(title: string, parentId = "1"): Promise<void> {
  await chrome.bookmarks.create({ parentId, title, url: `https://${title.toLowerCase()}.com` });
}

async function titles(parentId = "1"): Promise<string[]> {
  return (await chrome.bookmarks.getChildren(parentId)).map((c) => c.title);
}

describe("restoreBookmarks keeps the snapshot's order (#29)", () => {
  it("puts a missing bookmark back between the ones that survived", async () => {
    await seedLink("A");
    await seedLink("C");

    await restoreBookmarks(snapshot([link("A"), link("B"), link("C"), link("D")]));

    expect(await titles()).toEqual(["A", "B", "C", "D"]);
  });

  it("restores loose bookmarks around folders that survived, as on the bar in the report", async () => {
    // The shape from the field: the folders were still there, so they held positions 1 and 2,
    // and the loose bookmarks that sat between and around them came back after all of them.
    const f1 = await chrome.bookmarks.create({ parentId: "1", title: "F1" });
    await seedLink("X", f1.id);
    const f2 = await chrome.bookmarks.create({ parentId: "1", title: "F2" });
    await seedLink("Y", f2.id);

    await restoreBookmarks(snapshot([
      link("L1"), folder("F1", [link("X")]), link("L2"), folder("F2", [link("Y")]), link("L3"),
    ]));

    expect(await titles()).toEqual(["L1", "F1", "L2", "F2", "L3"]);
  });

  it("recreates a missing folder in its place, with its bookmarks in order", async () => {
    await seedLink("A");
    await seedLink("C");

    await restoreBookmarks(snapshot([link("A"), folder("Work", [link("W1"), link("W2")]), link("C")]));

    expect(await titles()).toEqual(["A", "Work", "C"]);
    const work = (await chrome.bookmarks.getChildren("1")).find((c) => c.title === "Work")!;
    expect(await titles(work.id)).toEqual(["W1", "W2"]);
  });

  it("anchors to the snapshot's neighbour rather than guessing around a bookmark it never knew", async () => {
    // "Local" was added here after the snapshot was taken. B belongs right after A, and the
    // restore has no basis for putting it anywhere relative to Local but next to A.
    await seedLink("A");
    await seedLink("Local");
    await seedLink("C");

    await restoreBookmarks(snapshot([link("A"), link("B"), link("C")]));

    expect(await titles()).toEqual(["A", "B", "Local", "C"]);
  });

  describe("when the bookmark that preceded it in the snapshot is not here", () => {
    // Deleting that neighbour cannot cause this: it is in the snapshot too, so the restore
    // brings it back first. What can is a neighbour the snapshot has that the restore does not
    // put back into the same folder. The previous placement then fell to the snapshot's raw
    // index, and any child the folder had gained since pushed that off.

    it("goes before the bookmark that followed it, when a folder has been renamed since", async () => {
      // Nothing in "Work" is missing, so the restore never recreates a folder by that name,
      // and the bookmark after it has no previous neighbour to find. "New" arrived at the
      // front of the bar after the snapshot, which is what threw the raw index off.
      await seedLink("New");
      await seedLink("A");
      const job = await chrome.bookmarks.create({ parentId: "1", title: "Job" });
      await seedLink("W", job.id);
      await seedLink("C");

      await restoreBookmarks(snapshot([link("A"), folder("Work", [link("W")]), link("N"), link("C")]));

      expect(await titles()).toEqual(["New", "A", "Job", "N", "C"]);
    });

    it("goes between its neighbours when the one before it now lives in another folder", async () => {
      // The same happens when that URL is also bookmarked in another folder: the restore finds
      // it present, so it does not put it back here.
      await seedLink("A");
      await seedLink("C");
      await seedLink("P", "2");

      await restoreBookmarks(snapshot([link("A"), link("P"), link("N"), link("C")]));

      expect(await titles()).toEqual(["A", "N", "C"]);
    });

    it("goes after the nearest earlier neighbour that is here, when nothing followed it", async () => {
      await seedLink("X");
      await seedLink("Y");
      await seedLink("Z");
      await seedLink("A");
      await seedLink("P", "2");

      await restoreBookmarks(snapshot([link("A"), link("P"), link("N")]));

      expect(await titles()).toEqual(["X", "Y", "Z", "A", "N"]);
    });

    it("keeps its place when the browser refuses to recreate the one before it", async () => {
      // A restore point taken in one browser can hold a link another will not create, a
      // chrome:// page on Firefox for one.
      const realCreate = chrome.bookmarks.create.bind(chrome.bookmarks);
      chrome.bookmarks.create = ((props: Parameters<typeof realCreate>[0]) =>
        props.url === "https://p.com"
          ? Promise.reject(new Error("Invalid URL"))
          : realCreate(props)) as typeof chrome.bookmarks.create;
      try {
        await seedLink("A");
        await seedLink("C");

        await restoreBookmarks(snapshot([link("A"), link("P"), link("N"), link("C")]));

        expect(await titles()).toEqual(["A", "N", "C"]);
      } finally {
        chrome.bookmarks.create = realCreate;
      }
    });

    it("recognises its neighbour when one browser stored the address with a trailing slash", async () => {
      // Orion keeps a bare origin without the slash that Chromium and Firefox add, and a restore
      // point is shared by every device, so the snapshot and this tree can disagree on it.
      await seedLink("X");
      await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });

      await restoreBookmarks(snapshot([link("A"), link("N")]));

      expect(await titles()).toEqual(["X", "A", "N"]);
    });
  });

  it("still adds only what is missing, and still clears this device's tombstones for it", async () => {
    await seedLink("A");
    await setTombstones([{ url: "https://b.com", deletedAt: Date.now() - 60_000, own: true }]);

    const added = await restoreBookmarks(snapshot([link("A"), link("B")]));

    expect(added).toBe(1);
    expect(await titles()).toEqual(["A", "B"]);
    expect(await getTombstones()).toEqual([]);
  });
});
