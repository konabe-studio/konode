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
// AND GECKO, FOR REAL. Playwright cannot load an extension into Firefox — there is no API
// for it — so the Firefox half is driven from the other side: web-ext installs the build as
// a temporary add-on over Firefox's remote debugging protocol, and a driver page inside the
// extension does what the Chromium harness does from outside, then posts what the browser
// ended up holding back to this script (lib/firefox.mjs, lib/driver/). Firefox publishes to
// a Chromium profile in one pass and restores what Chromium published in the other, so
// `tabs.group` and `tabGroups` on Gecko are exercised rather than assumed. Those two passes
// SKIP rather than fail where no Firefox is installed.
//
// Pass 6 runs on a real Firefox 138, the one version with `tabs.group` and no `tabGroups`.
// Passes 2 and 3 reproduce that BRANCH in Chromium by withholding the permission, and a
// modern Firefox asked without the grant lands there too — but only on 138 is the
// permission unknown, and asking whether it is held throws instead of answering false.
// That is a different failure, and the one that could have stopped the setup wizard.
//
// WHAT IT STILL DOES NOT COVER. The permission PROMPT: every build below holds the
// permissions it needs from the start, because both engines draw that dialog in browser
// chrome, where no automation can click it; `tabGroupsAskable` and `permissionsToEnable`
// have unit tests.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebdav } from "./lib/webdav-server.mjs";
import { startPages } from "./lib/pages.mjs";
import { startReporter } from "./lib/reporter.mjs";
import { buildWith, launchPeer, settingsFor } from "./lib/peer.mjs";
import { buildFirefoxDriver, firefoxBinary, runFirefoxDriver } from "./lib/firefox.mjs";

const repo = resolve(import.meta.dirname, "../..");
const dist = join(repo, "dist");
const distFirefox = join(repo, "dist-firefox");
const headless = !process.env.E2E_HEADFUL;

/** The nine colours both engines share — src/lib/types.ts TAB_GROUP_COLORS. */
const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

const WORK = ["work-1", "work-2"];
const READING = ["reading-1", "reading-2"];
const LOOSE = "loose-1";

const failures = [];
const skipped = [];
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
/** The envelope itself — checksum, encryption flag, timestamp — not its payload. */
function rawPacket(dav, deviceId) {
  const key = [...dav.files.keys()].find((p) => p.endsWith(`konode_sessions_${deviceId}.json`));
  return key ? JSON.parse(dav.files.get(key).toString("utf8")) : null;
}

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
  for (const t of session?.tabs ?? []) {
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

/**
 * Firefox 138: the one release with `tabs.group` and no `tabGroups`. Passes 2 and 3 take
 * the `membership` branch in Chromium by withholding the permission, and a modern Firefox
 * asked without the grant lands there too — but only on 138 is the permission UNKNOWN, and
 * that is a different thing entirely: `permissions.contains({permissions: ["tabGroups"]})`
 * throws there rather than answering false. One unknown permission fails the whole request,
 * which is what would have stopped the setup wizard dead, and what `tabGroupsAskable()`
 * exists to survive. No other engine reproduces it.
 */
/** A dist/ somebody built elsewhere — an older release, for the back-compat pass. */
async function builtDist(dir) {
  if (!dir) return null;
  try {
    await stat(join(dir, "manifest.json"));
    return dir;
  } catch {
    return null;
  }
}

async function legacyGecko() {
  const named = process.env.E2E_FIREFOX_138;
  const path = named ?? join(process.env.HOME ?? "", ".local/opt/firefox-138/firefox/firefox");
  try {
    await stat(path);
    return path;
  } catch {
    return null;
  }
}

async function main() {
  await stat(join(dist, "manifest.json")).catch(() => {
    throw new Error("dist/ is not built — run `npm run build` first");
  });

  const firefox = await firefoxBinary();
  const legacy = await legacyGecko();
  const dist140 = await builtDist(process.env.E2E_DIST_140);
  if (firefox) {
    await stat(join(distFirefox, "manifest.json")).catch(() => {
      throw new Error("dist-firefox/ is not built — run `npm run build:firefox` first");
    });
  }

  const work = await mkdtemp(join(tmpdir(), "konode-e2e-"));
  const pages = await startPages();
  const reporter = await startReporter();
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
    // ── 4. Gecko publishes, Chromium restores ─────────────────────────────
    scene = "firefox-to-chromium";
    if (!firefox) {
      console.log(`\n▸ ${scene}: SKIPPED — no Firefox found (install one, or set E2E_FIREFOX)`);
      skipped.push(scene);
    } else {
      console.log(`\n▸ ${scene}: a real Firefox publishes, a Chromium profile restores`);
      const dav = await startWebdav();
      const b = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-b`), davOrigin: dav.origin,
        id: `e2e-${scene}-b`, label: "B", headless,
      });
      peers.push(b);

      const ffId = `e2e-${scene}-ff`;
      const ext = await buildFirefoxDriver({
        dist: distFirefox,
        into: join(work, `${scene}-ff-ext`),
        grant: ["tabs", "tabGroups"],
        config: {
          role: "publish",
          named: true,
          reportUrl: reporter.url,
          settings: settingsFor(dav.origin, ffId, "Firefox"),
          pages: { work: WORK.map(url), reading: READING.map(url), loose: url(LOOSE) },
        },
      });
      const ff = await runFirefoxDriver({ extDir: ext, binary: firefox, reporter });
      check("the Firefox driver ran without an error", !ff.error, ff.error);
      check("Firefox reports full tab group support", ff.support === "full", ff.support);
      console.log(`     ${ff.userAgent}`);

      // Gecko's own grouping, before anything is synced: `tabs.group` there is the half
      // this pass could not reach until now.
      const ffGrouped = liveBuckets(ff.tabs ?? [], pages.origin);
      check("Firefox put its own tabs in two groups", ffGrouped.size === 2, JSON.stringify(partition(ffGrouped)));
      check("Firefox named them Work and Reading",
        same((ff.groups ?? []).map((g) => `${g.title}/${g.color}`), ["Work/blue", "Reading/red"]),
        JSON.stringify(ff.groups));

      const packet = published(dav, ffId);
      check("the packet Firefox published carries both groups",
        same((packet?.groups ?? []).map((g) => `${g.title}/${g.color}`), ["Work/blue", "Reading/red"]),
        JSON.stringify(packet?.groups));
      const looseOut = (packet?.tabs ?? []).find((t) => t.url === url(LOOSE));
      check("the tab Firefox pinned is published without a group",
        looseOut?.pinned === true && looseOut?.group === undefined, JSON.stringify(looseOut));

      await b.sync();
      const [entry] = await b.remoteSessions();
      check("the Chromium device received Firefox's session", Boolean(entry?.session?.tabs?.length));
      await b.restore(entry?.session?.id);
      await pause(400);

      const tabs = await b.tabs();
      check("Chromium opened all five of Firefox's tabs",
        same(tabs.filter((t) => ours.includes(t.url)).map((t) => t.url), ours));
      check("Chromium grouped them the way Firefox had them",
        same(partition(liveBuckets(tabs, pages.origin)), partition(packetBuckets(packet))),
        JSON.stringify(partition(liveBuckets(tabs, pages.origin))));
      check("Chromium carried Firefox's names and colours",
        same(((await b.groups()) ?? []).map((g) => `${g.title}/${g.color}`), ["Work/blue", "Reading/red"]),
        JSON.stringify(await b.groups()));
      await dav.close();
    }

    // ── 5. Chromium publishes, Gecko restores ─────────────────────────────
    scene = "chromium-to-firefox";
    if (!firefox) {
      console.log(`\n▸ ${scene}: SKIPPED — no Firefox found (install one, or set E2E_FIREFOX)`);
      skipped.push(scene);
    } else {
      console.log(`\n▸ ${scene}: a Chromium profile publishes, a real Firefox restores`);
      const dav = await startWebdav();
      const a = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-a`), davOrigin: dav.origin,
        id: `e2e-${scene}-a`, label: "A", headless,
      });
      peers.push(a);

      await a.openPages(ours);
      await a.pin(url(LOOSE));
      await a.group(WORK.map(url), { title: "Work", color: "blue" });
      await a.group(READING.map(url), { title: "Reading", color: "red" });
      await a.sync();
      const packet = published(dav, a.id);

      const ext = await buildFirefoxDriver({
        dist: distFirefox,
        into: join(work, `${scene}-ff-ext`),
        grant: ["tabs", "tabGroups"],
        config: {
          role: "receive",
          reportUrl: reporter.url,
          settings: settingsFor(dav.origin, `e2e-${scene}-ff`, "Firefox"),
        },
      });
      const ff = await runFirefoxDriver({ extDir: ext, binary: firefox, reporter });
      check("the Firefox driver ran without an error", !ff.error, ff.error);
      check("Firefox received the Chromium session", ff.received?.tabs === ours.length, JSON.stringify(ff.received));
      check("Firefox opened all five tabs",
        same((ff.tabs ?? []).filter((t) => ours.includes(t.url)).map((t) => t.url), ours),
        JSON.stringify((ff.tabs ?? []).map((t) => t.url)));
      check("Firefox grouped them the way Chromium had them",
        same(partition(liveBuckets(ff.tabs ?? [], pages.origin)), partition(packetBuckets(packet))),
        JSON.stringify(partition(liveBuckets(ff.tabs ?? [], pages.origin))));
      check("Firefox carried Chromium's names and colours",
        same((ff.groups ?? []).map((g) => `${g.title}/${g.color}`), ["Work/blue", "Reading/red"]),
        JSON.stringify(ff.groups));
      const looseIn = (ff.tabs ?? []).find((t) => t.url === url(LOOSE));
      check("the pinned tab came back pinned and ungrouped on Firefox",
        looseIn?.pinned === true && !(looseIn?.groupId >= 0), JSON.stringify(looseIn));
      await dav.close();
    }

    // ── 6. Firefox 138: the engine that does not know what tabGroups IS ───
    scene = "firefox-138";
    if (!legacy) {
      console.log(`\n▸ ${scene}: SKIPPED — no Firefox 138 (unpack one, or set E2E_FIREFOX_138)`);
      skipped.push(scene);
    } else {
      console.log(`\n▸ ${scene}: Chromium publishes names and colours, Firefox 138 takes what it can`);
      const dav = await startWebdav();
      const a = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-a`), davOrigin: dav.origin,
        id: `e2e-${scene}-a`, label: "A", headless,
      });
      peers.push(a);

      await a.openPages(ours);
      await a.pin(url(LOOSE));
      await a.group(WORK.map(url), { title: "Work", color: "blue" });
      await a.group(READING.map(url), { title: "Reading", color: "red" });
      await a.sync();
      const packet = published(dav, a.id);

      const ext = await buildFirefoxDriver({
        dist: distFirefox,
        into: join(work, `${scene}-ff-ext`),
        // Nothing to promote but `tabs`: 138 has no `tabGroups`, and leaving it in
        // optional_permissions is exactly the shape a shipped build has there.
        grant: ["tabs"],
        config: {
          role: "receive",
          reportUrl: reporter.url,
          settings: settingsFor(dav.origin, `e2e-${scene}-ff`, "Firefox 138"),
        },
      });
      const ff = await runFirefoxDriver({ extDir: ext, binary: legacy, reporter });
      check("the Firefox 138 driver ran without an error", !ff.error, ff.error);
      console.log(`     ${ff.userAgent}`);
      // The engine facts this pass exists for. A modern Firefox asked without the grant
      // answers `false` here; 138 throws, because it has never heard of the permission.
      check("138 does not know the tabGroups permission, and throws when asked",
        ff.containsThrew === true, `threw: ${ff.containsThrew}`);
      check("it has no tabGroups API either", ff.tabGroupsApi === false, `tabGroups api: ${ff.tabGroupsApi}`);
      check("so the extension settles on membership instead of failing",
        ff.support === "membership", ff.support);
      // Setup finishing is the regression this case exists for: settings applied and a
      // sync completed on an engine that throws at the capability question.
      check("settings applied and a sync completed there",
        ff.received?.tabs === ours.length, JSON.stringify(ff.received));
      check("it opened all five tabs",
        same((ff.tabs ?? []).filter((t) => ours.includes(t.url)).map((t) => t.url), ours),
        JSON.stringify((ff.tabs ?? []).map((t) => t.url)));
      check("it grouped them the way Chromium had them",
        same(partition(liveBuckets(ff.tabs ?? [], pages.origin)), partition(packetBuckets(packet))),
        JSON.stringify(partition(liveBuckets(ff.tabs ?? [], pages.origin))));
      check("the names and colours are simply not available there",
        ff.groups === null, JSON.stringify(ff.groups));
      const loose138 = (ff.tabs ?? []).find((t) => t.url === url(LOOSE));
      check("the pinned tab came back pinned and ungrouped",
        loose138?.pinned === true && !(loose138?.groupId >= 0), JSON.stringify(loose138));
      await dav.close();
    }

    // ── 7. An ungrouped session does not churn ───────────────────────────
    //    Groups were added to a packet every device already publishes, so the cost of
    //    the feature to somebody who never groups a tab must be exactly nothing.
    scene = "no-groups-no-churn";
    {
      console.log(`\n▸ ${scene}: nothing is grouped, so nothing should move`);
      const dav = await startWebdav();
      const a = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-a`), davOrigin: dav.origin,
        id: `e2e-${scene}-a`, label: "A", headless,
      });
      peers.push(a);

      await a.openPages(ours);
      await a.sync();
      const first = rawPacket(dav, a.id);
      const keys = Object.keys(JSON.parse(first?.payload ?? "{}"));
      check("an ungrouped session carries no groups key at all", !keys.includes("groups"), JSON.stringify(keys));

      await a.sync();
      const second = rawPacket(dav, a.id);
      check("a second sync with nothing changed leaves the checksum where it was",
        Boolean(first) && second?.checksum === first?.checksum,
        `${first?.checksum?.slice(0, 12)} → ${second?.checksum?.slice(0, 12)}`);

      // Keeps the two above from being vacuous: this checksum is live, so "it did not
      // move" means the session did not change, not that nothing ever moves it. Grouping
      // is only the cheapest way to change the session here — the browser also reorders
      // the tabs to sit together, so this says the checksum reacts, not that `groups` is
      // what it reacted to. Check one is what holds the groups key out of the packet.
      await a.group(WORK.map(url), { title: "Work", color: "blue" });
      await a.sync();
      const third = rawPacket(dav, a.id);
      check("while changing the session does move it",
        third?.checksum !== first?.checksum, `still ${third?.checksum?.slice(0, 12)}`);
      await dav.close();
    }

    // ── 8. Restoring the same session twice ──────────────────────────────
    scene = "restore-twice";
    {
      console.log(`\n▸ ${scene}: the second restore opens only what is new`);
      const dav = await startWebdav();
      const a = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-a`), davOrigin: dav.origin,
        id: `e2e-${scene}-a`, label: "A", headless,
      });
      const b = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-b`), davOrigin: dav.origin,
        id: `e2e-${scene}-b`, label: "B", headless,
      });
      peers.push(a, b);

      await a.openPages(ours);
      await a.group(WORK.map(url), { title: "Work", color: "blue" });
      await a.group(READING.map(url), { title: "Reading", color: "red" });
      await a.sync();
      await b.sync();
      const firstEntry = (await b.remoteSessions()).find((e) => e?.session?.tabs?.length);
      check("B received A's session", Boolean(firstEntry), "no session arrived");
      await b.restore(firstEntry.session.id);
      const afterFirst = (await b.tabs()).filter((t) => t.url?.startsWith(pages.origin));
      check("the first restore opened all five", afterFirst.length === ours.length, `${afterFirst.length} tabs`);

      // A adds a sixth tab to the Work group and publishes again.
      const extra = url("work-3");
      await a.openPages([extra]);
      await a.group([...WORK.map(url), extra], { title: "Work", color: "blue" });
      await a.sync();
      await b.sync();
      const secondEntry = (await b.remoteSessions()).find((e) => e?.session?.tabs?.length);
      await b.restore(secondEntry.session.id);
      const afterSecond = (await b.tabs()).filter((t) => t.url?.startsWith(pages.origin));
      check("the second restore opened only the new tab, not all six again",
        afterSecond.length === ours.length + 1, `${afterSecond.length} tabs`);
      // KNOWN GAP, found by this pass. `restoreGroups` groups only the tabs THIS restore
      // opened — deliberately, so a tab you have since moved is left where you put it. But
      // the new tab then forms its OWN group rather than joining the one already on screen,
      // and since the name and colour are applied to it too, you end up with two groups
      // called Work sitting side by side. Nothing about the "don't move what is open"
      // rule requires that: `tabs.group({tabIds, groupId})` adds a tab to an existing
      // group without touching the others. Asserted as it behaves TODAY so the suite is
      // honest; flip it to `joined` once that is decided.
      const buckets = [...liveBuckets(afterSecond, pages.origin).values()];
      const withOld = buckets.find((us) => us.includes(url(WORK[0])));
      const withNew = buckets.find((us) => us.includes(extra));
      const joined = withNew && withOld && same(withNew, withOld);
      check("the new tab is grouped, but in a SECOND group of the same name (open question)",
        Boolean(withNew) && !joined, JSON.stringify({ withOld, withNew }));
      const named = (await b.groups() ?? []).filter((g) => g.title === "Work");
      check("which is why Work appears twice on the receiver (open question)",
        named.length === 2, JSON.stringify(await b.groups()));
      await dav.close();
    }

    // ── 9. Groups ride inside the ENCRYPTED payload ──────────────────────
    scene = "encrypted";
    {
      console.log(`\n▸ ${scene}: E2EE on, the same passphrase on both`);
      const dav = await startWebdav();
      const secret = "e2e-passphrase-never-leaves-the-device";
      const aId = `e2e-${scene}-a`;
      const bId = `e2e-${scene}-b`;
      const sealed = (id, label) => ({
        ...settingsFor(dav.origin, id, label),
        encryption_enabled: true,
        encryption_passphrase: secret,
      });
      const a = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-a`), davOrigin: dav.origin,
        id: aId, label: "A", headless, settings: sealed(aId, "A"),
      });
      const b = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-b`), davOrigin: dav.origin,
        id: bId, label: "B", headless, settings: sealed(bId, "B"),
      });
      peers.push(a, b);

      await a.openPages(ours);
      await a.group(WORK.map(url), { title: "Work", color: "blue" });
      await a.group(READING.map(url), { title: "Reading", color: "red" });
      await a.sync();

      const raw = rawPacket(dav, aId);
      check("the packet went up encrypted", raw?.encrypted === true, JSON.stringify(raw?.encrypted));
      check("and the group's name is nowhere in the ciphertext",
        typeof raw?.payload === "string" && !raw.payload.includes("Work"), "the payload contains 'Work'");

      await b.sync();
      const entry = (await b.remoteSessions()).find((e) => e?.session?.tabs?.length);
      check("B read it with the same passphrase", Boolean(entry), "no session arrived");
      await b.restore(entry.session.id);
      const bTabs = await b.tabs();
      check("the grouping survived the round trip through the ciphertext",
        same(partition(liveBuckets(bTabs, pages.origin)), partition(liveBuckets(await a.tabs(), pages.origin))),
        JSON.stringify(partition(liveBuckets(bTabs, pages.origin))));
      check("and so did the names and colours",
        same((await b.groups() ?? []).map((g) => `${g.title}/${g.color}`), ["Work/blue", "Reading/red"]),
        JSON.stringify(await b.groups()));
      await dav.close();
    }

    // ── 10. A 1.4.0 build reads a packet that carries groups ─────────────
    //     The claim is that an older build IGNORES `groups` rather than choking on it.
    scene = "old-build";
    if (!dist140) {
      console.log(`\n▸ ${scene}: SKIPPED — set E2E_DIST_140 to a built 1.4.0 dist/`);
      skipped.push(scene);
    } else {
      console.log(`\n▸ ${scene}: a 1.4.0 device restores a session published today`);
      const dav = await startWebdav();
      const a = await launchPeer({
        extDir: full, profileDir: join(work, `${scene}-a`), davOrigin: dav.origin,
        id: `e2e-${scene}-a`, label: "A", headless,
      });
      // 1.4.0 has no `tabGroups` in its manifest at all — there was nothing to ask for yet.
      const old = await buildWith(dist140, join(work, "ext-140"), ["tabs"]);
      const b = await launchPeer({
        extDir: old, profileDir: join(work, `${scene}-b`), davOrigin: dav.origin,
        id: `e2e-${scene}-b`, label: "B (1.4.0)", headless,
      });
      peers.push(a, b);

      // `support()` asks the browser, and Chromium has `tabs.group` whatever build is
      // loaded — so the fact that makes this peer old is in its manifest, not its engine.
      const manifest140 = JSON.parse(await readFile(join(dist140, "manifest.json"), "utf8"));
      check("the old build never knew about tab groups",
        manifest140.version.startsWith("1.4.") && !JSON.stringify(manifest140).includes("tabGroups"),
        `${manifest140.version}, optional: ${JSON.stringify(manifest140.optional_permissions)}`);

      await a.openPages(ours);
      await a.pin(url(LOOSE));
      await a.group(WORK.map(url), { title: "Work", color: "blue" });
      await a.group(READING.map(url), { title: "Reading", color: "red" });
      await a.sync();
      check("the packet it published does carry groups",
        (published(dav, a.id)?.groups ?? []).length === 2, JSON.stringify(published(dav, a.id)?.groups));

      await b.sync();
      const entry = (await b.remoteSessions()).find((e) => e?.session?.tabs?.length);
      check("1.4.0 accepted the packet", Boolean(entry), "no session arrived");
      await b.restore(entry.session.id);
      const bTabs = (await b.tabs()).filter((t) => t.url?.startsWith(pages.origin));
      check("it opened all five tabs", bTabs.length === ours.length, `${bTabs.length} tabs`);
      check("and left every one of them ungrouped",
        bTabs.every((t) => !(t.groupId >= 0)), JSON.stringify(bTabs.map((t) => t.groupId)));
      const loud = (await b.audit()).filter((e) => e?.level === "error");
      check("with nothing alarming in its Activity log",
        loud.length === 0, JSON.stringify(loud.slice(0, 2)));
      await dav.close();
    }

  } finally {
    for (const p of peers) await p.close();
    await pages.close();
    await reporter.close();
    if (process.env.E2E_KEEP) console.log(`\nprofiles kept in ${work}`);
    else await rm(work, { recursive: true, force: true });
  }

  console.log("");
  if (failures.length) {
    if (skipped.length) console.log(`skipped: ${skipped.join(", ")}`);
    console.log(`${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("every check passed — tab groups survive a real sync: Chromium to Chromium,");
    console.log("Chromium to Firefox and back, and both ways across the tabGroups permission.");
    if (skipped.length) console.log(`skipped: ${skipped.join(", ")}`);
    console.log("not covered: the permission prompt itself (see the header).");
  }
}

await main();
