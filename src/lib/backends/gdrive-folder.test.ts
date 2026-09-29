import { describe, it, expect, afterEach, vi } from "vitest";
import { GDriveBackend, pickCanonical } from "./gdrive-backend";
import { KEYS, setLastUploadChecksum } from "@/lib/utils/storage";
import type { BackendConfig } from "@/lib/types";

// Drive has no atomic create-if-absent. Two devices setting up at the same moment both
// see an empty Drive and both create a "Konode" folder; a retried upload whose create
// response was lost can leave two files with the same name. Taking files[0] then let the
// devices settle on DIFFERENT duplicates and sync into separate folders forever, each
// convinced it was alone. Duplicates can't always be prevented — agreeing which one wins
// can, and that's what these cover.

const config = (): BackendConfig => ({ type: "gdrive", label: "Google Drive", enabled: true, gdrive: {} });

async function signIn(): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.GDRIVE_SESSION]: {
      access_token: "test-token",
      expires_at: Date.now() + 3_600_000, // fresh, so no refresh round-trip
      email: "a@b.c",
      displayName: "Tester",
      savedAt: Date.now(),
    },
  });
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pickCanonical", () => {
  it("takes the oldest by createdTime", () => {
    const files = [
      { id: "newer", createdTime: "2026-07-20T10:00:00.000Z" },
      { id: "oldest", createdTime: "2026-07-01T09:00:00.000Z" },
      { id: "middle", createdTime: "2026-07-10T09:00:00.000Z" },
    ];
    expect(pickCanonical(files)?.id).toBe("oldest");
    // Order of the input must not matter — two devices see different listing orders.
    expect(pickCanonical([...files].reverse())?.id).toBe("oldest");
  });

  it("falls back to the id, so the choice is still deterministic without createdTime", () => {
    expect(pickCanonical([{ id: "zzz" }, { id: "aaa" }, { id: "mmm" }])?.id).toBe("aaa");
  });

  it("is undefined for no matches, and does not mutate its input", () => {
    const files = [{ id: "b" }, { id: "a" }];
    expect(pickCanonical([])).toBeUndefined();
    pickCanonical(files);
    expect(files.map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("GDriveBackend.connect — duplicate Konode folders", () => {
  it("picks the same folder on every device when duplicates exist", async () => {
    await signIn();
    const listing = {
      files: [
        { id: "folder-B", name: "Konode", createdTime: "2026-07-20T10:00:00.000Z" },
        { id: "folder-A", name: "Konode", createdTime: "2026-07-01T09:00:00.000Z" },
      ],
    };
    vi.stubGlobal("fetch", () => Promise.resolve(json(listing)));

    const a = new GDriveBackend(config());
    await a.connect();
    // A second device sees the same two folders in the OTHER order.
    vi.stubGlobal("fetch", () => Promise.resolve(json({ files: [...listing.files].reverse() })));
    const b = new GDriveBackend(config());
    await b.connect();

    // Both must be in folder-A (the older one) — this is what stops the group splitting.
    const idOf = (be: GDriveBackend): string | null =>
      (be as unknown as { folderId: string | null }).folderId;
    expect(idOf(a)).toBe("folder-A");
    expect(idOf(b)).toBe(idOf(a));
  });

  it("yields to the older folder when another device created one at the same moment", async () => {
    await signIn();
    let call = 0;
    vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") return Promise.resolve(json({ id: "mine-newer" }));
      call++;
      // 1st lookup: empty — so we create. 2nd lookup (the re-check): the peer's folder is
      // there too, and it is older.
      return Promise.resolve(json({
        files: call === 1 ? [] : [
          { id: "mine-newer", name: "Konode", createdTime: "2026-07-20T10:00:00.100Z" },
          { id: "peer-older", name: "Konode", createdTime: "2026-07-20T10:00:00.000Z" },
        ],
      }));
    });

    const be = new GDriveBackend(config());
    await be.connect();

    expect((be as unknown as { folderId: string | null }).folderId).toBe("peer-older");
  });

  it("keeps the folder it created when it really was first", async () => {
    await signIn();
    let call = 0;
    vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") return Promise.resolve(json({ id: "mine" }));
      call++;
      return Promise.resolve(json({
        files: call === 1 ? [] : [{ id: "mine", name: "Konode", createdTime: "2026-07-20T10:00:00.000Z" }],
      }));
    });

    const be = new GDriveBackend(config());
    await be.connect();

    expect((be as unknown as { folderId: string | null }).folderId).toBe("mine");
  });

  it("uses a configured folderId without looking anything up", async () => {
    await signIn();
    const fetchSpy = vi.fn(() => Promise.resolve(json({ files: [] })));
    vi.stubGlobal("fetch", fetchSpy);

    const be = new GDriveBackend({ ...config(), gdrive: { folderId: "pinned" } });
    await be.connect();

    expect((be as unknown as { folderId: string | null }).folderId).toBe("pinned");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GDriveBackend.connect — a transient Drive error", () => {
  // connect() looks the folder up on every sync, and that lookup was the one Drive call
  // outside withRetry: a single 500 from Drive failed the whole cycle and wrote an error to
  // the Activity log, which the upload path beside it would have ridden out.
  const folderIdOf = (be: GDriveBackend): string | null =>
    (be as unknown as { folderId: string | null }).folderId;

  it("retries a 500 on the folder lookup instead of failing the sync", async () => {
    await signIn();
    let call = 0;
    vi.stubGlobal("fetch", () => {
      call++;
      return Promise.resolve(call === 1
        ? json({ error: "backendError" }, 500)
        : json({ files: [{ id: "folder-A", name: "Konode", createdTime: "2026-07-01T09:00:00.000Z" }] }));
    });

    const be = new GDriveBackend(config());
    await be.connect();

    expect(folderIdOf(be)).toBe("folder-A");
    expect(call).toBe(2);
  });

  it("does not retry a 403, which a second try cannot fix", async () => {
    await signIn();
    let call = 0;
    vi.stubGlobal("fetch", () => { call++; return Promise.resolve(json({}, 403)); });

    await expect(new GDriveBackend(config()).connect()).rejects.toThrow(/folder lookup failed: 403/);
    expect(call).toBe(1);
  });
});

describe("GDriveBackend — a folder move must invalidate the upload checksums", () => {
  // destinationTag() is built from the CONFIG, and Drive's folder isn't in the config —
  // it's resolved by lookup. So the tag can't see a change here, and a device that started
  // writing into a different folder kept its checksums and left the new folder EMPTY while
  // reporting a clean sync. Reachable: the duplicate-folder warning tells the user the
  // extra folder can be deleted, and trashing the wrong one sends the device somewhere new.
  const checksums = async (): Promise<Record<string, string> | undefined> =>
    ((await chrome.storage.local.get(KEYS.UPLOAD_CHECKSUMS)) as Record<string, Record<string, string>>)[
      KEYS.UPLOAD_CHECKSUMS
    ];

  const connectTo = async (folderId: string): Promise<void> => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(json({ files: [{ id: folderId, name: "Konode", createdTime: "2026-07-01T00:00:00.000Z" }] }))
    );
    await new GDriveBackend(config()).connect();
  };

  it("clears them when the resolved folder changes", async () => {
    await signIn();
    await setLastUploadChecksum("bookmarks", "gdrive:default|plain:abc");

    await connectTo("folder-1");
    expect(await checksums()).toBeDefined(); // first run: nothing to invalidate

    await connectTo("folder-2"); // e.g. the old one was trashed
    expect(await checksums()).toBeUndefined(); // → every type re-uploads into the new folder
  });

  it("leaves them alone when the folder is unchanged", async () => {
    await signIn();
    await connectTo("folder-1");
    await setLastUploadChecksum("bookmarks", "gdrive:default|plain:abc");

    await connectTo("folder-1");
    await connectTo("folder-1");

    expect(await checksums()).toEqual({ bookmarks: "gdrive:default|plain:abc" });
  });

  it("does not clear on the very first resolve — there is nothing to invalidate", async () => {
    await signIn();
    await setLastUploadChecksum("bookmarks", "carried-over-from-an-older-build");

    await connectTo("folder-1");

    // The upgrade path relies on the TAG FORMAT change to force that re-upload, not on this.
    expect(await checksums()).toEqual({ bookmarks: "carried-over-from-an-older-build" });
  });
});
