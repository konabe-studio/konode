// What a folder kept out of the sync does to the devices around it (#54), in two real
// browsers.
//
// The unit tests prove the recorders in isolation against a fake chrome.bookmarks. They
// cannot prove the thing this pass is about, which is a SEQUENCE across two devices and a
// real backend: tick a folder out of the sync, change it while it is out, untick it, and
// see what the other device ends up holding. The bug this pass was written for is that the
// answer used to be "nothing" — the change was real on one device and invisible everywhere
// else, for good.
//
// Both devices are Chromium, because what is under test is the bookmark merge and the
// exclusion rules, neither of which has an engine-specific branch. Firefox's bookmark
// differences (onRemoved without descendants) are covered where they live, in the unit
// tests for withRemovedContents.
//
// WHAT IT ALSO PINS DOWN: the limits. A folder rename comes back because the rule that was
// holding the folder out still carries the name it had; a rename INSIDE it does not, and a
// bookmark moved while excluded does not take its new place with it. Those are asserted
// here as the measured facts they are, so that changing them is a deliberate act rather
// than a surprise.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebdav } from "./lib/webdav-server.mjs";
import { launchPeer, settingsFor } from "./lib/peer.mjs";

const repo = resolve(import.meta.dirname, "../..");
const dist = join(repo, "dist");
const headless = !process.env.E2E_HEADFUL;

const failures = [];
let scene = "";
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${scene} → ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`   ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

/**
 * The bookmarks bar as a person would read it: a bookmark by its title, a folder as
 * "[title] child,child". One string per top-level entry, so a check shows what changed
 * rather than a tree dump.
 */
async function bar(peer) {
  return peer.worker.evaluate(async () => {
    const roots = (await chrome.bookmarks.getTree())[0].children ?? [];
    const barId = roots[0]?.id;
    const out = [];
    for (const k of await chrome.bookmarks.getChildren(barId)) {
      if (k.url) { out.push(k.title); continue; }
      const inner = await chrome.bookmarks.getChildren(k.id);
      out.push(`[${k.title}] ${inner.map((c) => c.title).join(",")}`);
    }
    return out;
  });
}

/** A folder on the bar with some bookmarks in it. Returns its local id. */
async function seedFolder(peer, title, entries) {
  return peer.worker.evaluate(async ([name, list]) => {
    const roots = (await chrome.bookmarks.getTree())[0].children ?? [];
    const f = await chrome.bookmarks.create({ parentId: roots[0].id, title: name });
    for (const [t, url] of list) await chrome.bookmarks.create({ parentId: f.id, title: t, url });
    return f.id;
  }, [title, entries]);
}

/** Rename whatever node holds this title, anywhere in the tree. */
async function renameByTitle(peer, from, to) {
  return peer.worker.evaluate(async ([was, now]) => {
    const flat = [];
    const walk = (n) => { flat.push(n); (n.children ?? []).forEach(walk); };
    (await chrome.bookmarks.getTree()).forEach(walk);
    const node = flat.find((n) => n.title === was);
    if (!node) throw new Error(`no node titled ${was}`);
    await chrome.bookmarks.update(node.id, { title: now });
    return node.id;
  }, [from, to]);
}

/** Move the bookmark with this title into the folder with that title. */
async function moveByTitle(peer, title, intoFolder) {
  return peer.worker.evaluate(async ([what, into]) => {
    const flat = [];
    const walk = (n) => { flat.push(n); (n.children ?? []).forEach(walk); };
    (await chrome.bookmarks.getTree()).forEach(walk);
    const node = flat.find((n) => n.title === what && n.url);
    const folder = flat.find((n) => n.title === into && !n.url);
    if (!node || !folder) throw new Error(`move ${what} → ${into}: not found`);
    await chrome.bookmarks.move(node.id, { parentId: folder.id });
  }, [title, intoFolder]);
}

/** The Activity log lines this pass cares about, newest first. */
async function lines(peer, action) {
  return (await peer.audit()).filter((e) => e.action === action).map((e) => e.detail ?? "");
}

const show = (xs) => JSON.stringify(xs);
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Both devices sync, A first: A publishes, B folds it in. */
async function settle(a, b) {
  await a.sync();
  await b.sync();
  await pause(200);
}

async function main() {
  await stat(join(dist, "manifest.json")).catch(() => {
    throw new Error("dist/ is not built — run `npm run build` first");
  });

  const work = await mkdtemp(join(tmpdir(), "konode-e2e-bm-"));
  const dav = await startWebdav();
  const peers = [];

  try {
    const open = async (label) => {
      const peer = await launchPeer({
        extDir: dist,
        profileDir: join(work, `bm-${label}`),
        davOrigin: dav.origin,
        id: `e2e-bm-${label}`,
        label,
        headless,
        settings: settingsFor(dav.origin, `e2e-bm-${label}`, label, ["bookmarks"]),
      });
      peers.push(peer);
      return peer;
    };

    const a = await open("A");
    const b = await open("B");

    // ── 1. The folder reaches the other device in the first place ──────────
    scene = "shared";
    console.log(`\n▸ ${scene}: A's folder reaches B`);
    const workId = await seedFolder(a, "Work", [
      ["one", "https://example.com/one"],
      ["two", "https://example.com/two"],
      ["three", "https://example.com/three"],
    ]);
    await settle(a, b);
    check("B has the folder and all three bookmarks",
      show(await bar(b)) === show(["[Work] one,two,three"]), show(await bar(b)));

    // ── 2. Out of the sync: changes stay here, and B keeps its copy ─────────
    scene = "excluded";
    console.log(`\n▸ ${scene}: ticked out of the sync, then changed here`);
    const rule = [{ path: ["bar", "Work"], id: workId }];
    await a.saveSettings({ excluded_bookmarks: rule });
    await renameByTitle(a, "one", "one-renamed");
    await renameByTitle(a, "Work", "Job");
    await settle(a, b);

    check("A holds the changes", show(await bar(a)) === show(["[Job] one-renamed,two,three"]), show(await bar(a)));
    check("B is untouched — excluding deletes nothing and changes nothing",
      show(await bar(b)) === show(["[Work] one,two,three"]), show(await bar(b)));
    check("and A recorded nothing about it while it was out",
      show(await lines(a, "Bookmarks")) === show([]), show(await lines(a, "Bookmarks")));

    // ── 3. Unticked: what changed while it was out goes out now ────────────
    scene = "released";
    console.log(`\n▸ ${scene}: unticked, so the changes are published`);
    await a.saveSettings({ excluded_bookmarks: [] });

    const said = await lines(a, "Bookmarks");
    check("A says what it put back", said.length === 1, show(said));
    check("three bookmarks and the one folder rename",
      said[0] === "Put 3 bookmark(s) and 1 folder rename(s) back into the sync", show(said));

    await settle(a, b);
    check("B now has the folder's new name AND the bookmark's",
      show(await bar(b)) === show(["[Job] one-renamed,two,three"]), show(await bar(b)));
    check("and A is unchanged by its own publish",
      show(await bar(a)) === show(["[Job] one-renamed,two,three"]), show(await bar(a)));

    // ── 4. It settles: the rename does not come round again ────────────────
    scene = "settles";
    console.log(`\n▸ ${scene}: nothing bounces back on the syncs after it`);
    const before = (await b.audit()).length;
    await settle(a, b);
    await settle(a, b);
    const merges = (await lines(b, "mergeBookmarks")).filter((d) => !/renamed 0\+0/.test(d));
    check("B applied the rename once, not on every sync",
      merges.length === 1, show(merges));
    check("and B's log did not fill up", (await b.audit()).length - before <= 2,
      String((await b.audit()).length - before));

    // ── 5. The limits, measured rather than assumed ────────────────────────
    scene = "limits";
    console.log(`\n▸ ${scene}: what does NOT come back, on purpose`);

    // A nested folder: the rule holds the name of the folder it was made for, and nothing
    // holds the name of a folder INSIDE it.
    const nestedId = await a.worker.evaluate(async () => {
      const flat = [];
      const walk = (n) => { flat.push(n); (n.children ?? []).forEach(walk); };
      (await chrome.bookmarks.getTree()).forEach(walk);
      const job = flat.find((n) => n.title === "Job" && !n.url);
      const inner = await chrome.bookmarks.create({ parentId: job.id, title: "Inner" });
      await chrome.bookmarks.create({ parentId: inner.id, title: "deep", url: "https://example.com/deep" });
      return inner.id;
    });
    await settle(a, b);
    check("B received the nested folder", show(await bar(b)).includes("Inner"), show(await bar(b)));

    await a.saveSettings({ excluded_bookmarks: [{ path: ["bar", "Job"], id: await a.worker.evaluate(async () => {
      const flat = [];
      const walk = (n) => { flat.push(n); (n.children ?? []).forEach(walk); };
      (await chrome.bookmarks.getTree()).forEach(walk);
      return flat.find((n) => n.title === "Job" && !n.url).id;
    }) }] });
    await renameByTitle(a, "Inner", "Inner-renamed");
    await moveByTitle(a, "two", "Inner-renamed");
    await a.saveSettings({ excluded_bookmarks: [] });
    await settle(a, b);

    const bNow = await b.worker.evaluate(async () => {
      const flat = [];
      const walk = (n) => { flat.push(n); (n.children ?? []).forEach(walk); };
      (await chrome.bookmarks.getTree()).forEach(walk);
      const inner = flat.find((n) => !n.url && /^Inner/.test(n.title));
      const two = flat.find((n) => n.title === "two");
      const parent = two ? flat.find((n) => n.id === two.parentId) : null;
      return { innerTitle: inner?.title ?? null, twoParent: parent?.title ?? null };
    });
    check("a folder renamed INSIDE an excluded one keeps its old name on B",
      bNow.innerTitle === "Inner", String(bNow.innerTitle));
    check("and a bookmark moved while excluded does not take its new place with it",
      bNow.twoParent !== "Inner-renamed" && bNow.twoParent !== "Inner", String(bNow.twoParent));
    check("while the bookmark titles in the released folder did come back",
      show(await lines(a, "Bookmarks")).includes("back into the sync"), show(await lines(a, "Bookmarks")));
    void nestedId;
  } finally {
    await Promise.all(peers.map((p) => p.close()));
    await dav.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("every check passed — a folder taken out of the sync and put back carries");
  console.log("its bookmark renames and its own rename with it, and the limits around that");
  console.log("are where this pass says they are.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
