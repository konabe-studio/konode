// Does a tab group actually survive a sync? (#11)
//
// Two throwaway Chromium profiles with the extension loaded, a WebDAV server on
// localhost, and no staging anywhere: the group is made in one browser with the browser's
// own API, published, and read back out of the other after a restore. Every assertion is
// made against what the browser ended up holding, or against the packet as it sat on the
// server — never against a mock.
//
// WHAT THE PAIRS MEAN. The engine difference that matters for groups is not Chromium
// against Gecko, it is whether `tabGroups` is held: `tabGroupSupport()` answers "full"
// only with the permission and `membership` without it, and Firefox 138 lands in
// "membership" because it has `tabs.group` and no `tabGroups` at all. A Chromium profile
// that was never granted the permission takes that same branch, byte for byte, which is
// what the second and third pass below are: a device that cannot name a group publishing
// to one that can, and the other way round.
//
// WHAT IT DOES NOT COVER. Gecko itself. Playwright cannot load an extension into Firefox
// — there is no API for it — so no part of this runs on Firefox, and `tabs.group`'s own
// behaviour there is unverified by this pass. web-ext can run Firefox with the extension
// loaded and would be the way to add it; it is not wired up here, and this machine has no
// Firefox installed. The permission PROMPT is not covered either: the builds below hold
// the permission from the start, because the dialog is drawn in browser chrome where
// Playwright cannot click it. `tabGroupsAskable` and `permissionsToEnable` have unit tests.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebdav } from "./lib/webdav-server.mjs";
import { startPages } from "./lib/pages.mjs";
import { buildWith, launchPeer } from "./lib/peer.mjs";

const repo = resolve(import.meta.dirname, "../..");
const dist = join(repo, "dist");
const headless = !process.env.E2E_HEADFUL;

/** The nine colours both engines share — src/lib/types.ts TAB_GROUP_COLORS. */
const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

const WORK = ["work-1", "work-2"];
const READING = ["reading-1", "reading-2"];
const LOOSE = "loose-1";

const failures = [];
let scene = "";
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${scene} → ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`   ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const sorted = (xs) => [...xs].sort();
const show = (xs) => JSON.stringify(sorted(xs));
const same = (a, b) => show(a) === show(b);
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** The session a device actually published, read back off the server. */
function published(dav, deviceId) {
  const key = [...dav.files.keys()].find((p) => p.endsWith(`konode_sessions_${deviceId}.json`));
  if (!key) return null;
  const packet = JSON.parse(dav.files.get(key).toString("utf8"));
  if (packet.encrypted) throw new Error("the packet is encrypted; this pass runs with E2EE off");
  return JSON.parse(packet.payload);
}

/** Which tabs the PACKET puts together: one entry per group index, URLs inside. */
function packetBuckets(session) {
  const out = new Map();
  for (const t of session.tabs ?? []) {
    if (typeof t.group !== "number") continue;
    out.set(t.group, [...(out.get(t.group) ?? []), t.url]);
  }
  return out;
}

/** Which tabs the BROWSER puts together, counting only the pass's own pages. */
function liveBuckets(tabs, origin) {
  const out = new Map();
  for (const t of tabs) {
    if (!t.url?.startsWith(origin) || typeof t.groupId !== "number" || t.groupId < 0) continue;
    out.set(t.groupId, [...(out.get(t.groupId) ?? []), t.url]);
  }
  return out;
}

/** A partition as a comparable thing: the sorted members of each group, sorted. */
const partition = (buckets) => sorted([...buckets.values()].map((us) => show(us)));

async function main() {
  await stat(join(dist, "manifest.json")).catch(() => {
    throw new Error("dist/ is not built — run `npm run build` first");
  });

  const work = await mkdtemp(join(tmpdir(), "konode-e2e-"));
  const pages = await startPages();
  const url = (n) => pages.url(n);
  const ours = [...WORK, ...READING, LOOSE].map(url);

  // Two builds of the same extension: one that holds `tabGroups`, one that never gets it.
  const full = await buildWith(dist, join(work, "ext-full"), ["tabs", "tabGroups"]);
  const membership = await buildWith(dist, join(work, "ext-membership"), ["tabs"]);

  const peers = [];
  const openPair = async (aExt, bExt) => {
    const dav = await startWebdav();
    const a = await launchPeer({
      extDir: aExt, profileDir: join(work, `${scene}-a`), davOrigin: dav.origin,
      id: `e2e-${scene}-a`, label: "A", headless,
    });
    const b = await launchPeer({
      extDir: bExt, profileDir: join(work, `${scene}-b`), davOrigin: dav.origin,
      id: `e2e-${scene}-b`, label: "B", headless,
    });
    peers.push(a, b);
    return { dav, a, b };
  };

  /** A publishes two named groups and a pinned loose tab; B restores them. */
  const publishAndRestore = async (a, b, named) => {
    await a.openPages(ours);
    await a.pin(url(LOOSE));
    await a.group(WORK.map(url), named ? { title: "Work", color: "blue" } : null);
    await a.group(READING.map(url), named ? { title: "Reading", color: "red" } : null);
    await a.sync();
    await b.sync();
    const [entry] = await b.remoteSessions();
    check("B received A's session", Boolean(entry?.session?.tabs?.length), JSON.stringify(entry?.session?.tabs?.length));
    await b.restore(entry?.session?.id);
    await pause(400);
    return entry?.session;
  };

  try {
    // ── 1. Two Chromium devices that may both name groups ─────────────────
    scene = "chromium-to-chromium";
    console.log(`\n▸ ${scene}: both devices hold tabGroups`);
    {
      const { dav, a, b } = await openPair(full, full);
      check("A reports full tab group support", (await a.support()) === "full", await a.support());

      // Before any grouping: the packet must look exactly like it did before #11.
      await a.openPages(ours);
      await a.sync();
      const plain = published(dav, a.id);
      check("an ungrouped session carries no groups key", plain !== null && !("groups" in plain));
      check("…and no tab carries a group index", (plain?.tabs ?? []).every((t) => t.group === undefined));

      await a.pin(url(LOOSE));
      await a.group(WORK.map(url), { title: "Work", color: "blue" });
      await a.group(READING.map(url), { title: "Reading", color: "red" });
      await a.sync();

      const packet = published(dav, a.id);
      const titles = (packet.groups ?? []).map((g) => g.title);
      check("the packet carries both groups", same(titles, ["Work", "Reading"]), show(titles));
      const byTitle = Object.fromEntries((packet.groups ?? []).map((g, i) => [g.title, { i, color: g.color }]));
      check("Work is blue, Reading is red", byTitle.Work?.color === "blue" && byTitle.Reading?.color === "red",
        JSON.stringify(packet.groups));
      const buckets = packetBuckets(packet);
      check("Work holds the two work tabs", same(buckets.get(byTitle.Work?.i) ?? [], WORK.map(url)));
      check("Reading holds the two reading tabs", same(buckets.get(byTitle.Reading?.i) ?? [], READING.map(url)));
      const loose = (packet.tabs ?? []).find((t) => t.url === url(LOOSE));
      check("the pinned tab is published without a group", loose?.pinned === true && loose?.group === undefined,
        JSON.stringify(loose));

      await b.sync();
      const [entry] = await b.remoteSessions();
      check("B received A's session", Boolean(entry?.session?.tabs?.length));
      await b.restore(entry?.session?.id);
      await pause(400);

      const tabs = await b.tabs();
      const opened = tabs.filter((t) => ours.includes(t.url)).map((t) => t.url);
      check("B opened all five tabs", same(opened, ours), show(opened));
      check("B grouped them the way A had them",
        same(partition(liveBuckets(tabs, pages.origin)), partition(packetBuckets(packet))),
        `${JSON.stringify(partition(liveBuckets(tabs, pages.origin)))} vs ${JSON.stringify(partition(packetBuckets(packet)))}`);
      const bGroups = await b.groups();
      check("B's groups carry A's names and colours",
        same((bGroups ?? []).map((g) => `${g.title}/${g.color}`), ["Work/blue", "Reading/red"]),
        JSON.stringify(bGroups));
      const bLoose = tabs.find((t) => t.url === url(LOOSE));
      check("the pinned tab came back pinned and ungrouped", bLoose?.pinned === true && bLoose?.groupId < 0,
        JSON.stringify(bLoose));
      await dav.close();
    }

    // ── 2. The receiver cannot name groups (a Firefox 138 shape) ──────────
    scene = "named-to-nameless";
    console.log(`\n▸ ${scene}: A holds tabGroups, B is on the Firefox 138 branch`);
    {
      const { dav, a, b } = await openPair(full, membership);
      check("B reports membership-only support", (await b.support()) === "membership", await b.support());
      check("B cannot read group names at all", (await b.groups()) === null);
      const session = await publishAndRestore(a, b, true);

      const tabs = await b.tabs();
      const opened = tabs.filter((t) => ours.includes(t.url)).map((t) => t.url);
      check("B opened all five tabs", same(opened, ours), show(opened));
      check("B still put the same tabs together",
        same(partition(liveBuckets(tabs, pages.origin)), partition(packetBuckets(session))),
        JSON.stringify(partition(liveBuckets(tabs, pages.origin))));
      check("B made exactly two groups", liveBuckets(tabs, pages.origin).size === 2);
      await dav.close();
    }

    // ── 3. The publisher cannot name groups (a Firefox 138 publisher) ─────
    scene = "nameless-to-named";
    console.log(`\n▸ ${scene}: A is on the Firefox 138 branch, B holds tabGroups`);
    {
      const { dav, a, b } = await openPair(membership, full);
      check("A reports membership-only support", (await a.support()) === "membership", await a.support());
      const session = await publishAndRestore(a, b, false);

      check("the packet carries both groups, unnamed",
        JSON.stringify(session.groups) === JSON.stringify([{}, {}]), JSON.stringify(session.groups));
      check("the tabs still carry their group index", packetBuckets(session).size === 2);

      const tabs = await b.tabs();
      check("B opened all five tabs", same(tabs.filter((t) => ours.includes(t.url)).map((t) => t.url), ours));
      check("B put the same tabs together",
        same(partition(liveBuckets(tabs, pages.origin)), partition(packetBuckets(session))));
      const bGroups = (await b.groups()) ?? [];
      check("B's groups are unnamed, in a colour the browser picked",
        bGroups.length === 2 && bGroups.every((g) => !g.title && COLORS.includes(g.color)),
        JSON.stringify(bGroups));
      await dav.close();
    }
  } finally {
    for (const p of peers) await p.close();
    await pages.close();
    if (process.env.E2E_KEEP) console.log(`\nprofiles kept in ${work}`);
    else await rm(work, { recursive: true, force: true });
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("every check passed — tab groups survive a real sync, both ways across the permission.");
    console.log("not covered: Gecko itself, and the permission prompt (see the header).");
  }
}

await main();
