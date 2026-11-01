// The Firefox half of the tab group pass, driven from inside the extension.
//
// Playwright cannot load an extension into Firefox, and nothing outside the extension can
// reach `browser.tabs.group` anyway, so on Gecko the driver IS part of the extension: this
// page holds the extension's own privileges, does what the Chromium harness does from
// outside, and posts what the browser ended up holding back to the node script, which is
// where the assertions live.
//
// It only ever runs in a copy of the build that the pass made (see lib/firefox.mjs);
// nothing here ships.
const out = document.getElementById("log");
const log = (line) => {
  out.textContent += `\n${line}`;
  console.log(`[e2e] ${line}`);
};

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const config = await (await fetch(browser.runtime.getURL("e2e-config.json"))).json();
log(`role: ${config.role}`);

/** A Konode message, from a context that is not the background, as the popup sends them. */
async function send(type, payload) {
  const answer = await browser.runtime.sendMessage(payload === undefined ? { type } : { type, payload });
  if (answer?.type !== "OK") throw new Error(`${type} answered ${JSON.stringify(answer)}`);
  return answer;
}

/** What `tabGroupSupport()` would answer here, asked the way it asks. */
async function support() {
  if (typeof browser.tabs?.group !== "function") return "none";
  let granted = false;
  try { granted = await browser.permissions.contains({ permissions: ["tabGroups"] }); } catch { granted = false; }
  return browser.tabGroups && granted ? "full" : "membership";
}

/**
 * The two engine facts the Firefox 138 pass rests on, asked the way the extension asks.
 * 138 is the one release with `tabs.group` and no `tabGroups`, and an unknown permission
 * is what `tabGroupsAskable()` has to survive: one of them fails the WHOLE request, which
 * would have stopped the wizard dead.
 */
async function engineFacts() {
  const facts = { tabGroupsApi: Boolean(browser.tabGroups) };
  try {
    await browser.permissions.contains({ permissions: ["tabGroups"] });
    facts.containsThrew = false;
  } catch {
    facts.containsThrew = true;
  }
  return facts;
}

async function tabsNow() {
  return (await browser.tabs.query({})).map((t) => ({
    url: t.url, title: t.title, pinned: t.pinned, groupId: t.groupId, windowId: t.windowId,
  }));
}

async function groupsNow() {
  let granted = false;
  try { granted = await browser.permissions.contains({ permissions: ["tabGroups"] }); } catch { granted = false; }
  if (!browser.tabGroups || !granted) return null;
  return (await browser.tabGroups.query({})).map((g) => ({ id: g.id, title: g.title, color: g.color }));
}

async function idsFor(urls) {
  const open = await browser.tabs.query({});
  const ids = urls.map((u) => open.find((t) => t.url === u)?.id);
  if (ids.some((x) => typeof x !== "number")) {
    const missing = urls.filter((_, i) => typeof ids[i] !== "number");
    throw new Error(`not open here: ${missing.join(", ")} — open: ${JSON.stringify(open.map((t) => t.url))}`);
  }
  return ids;
}

async function openPages(urls) {
  for (const url of urls) {
    const tab = await browser.tabs.create({ url, active: false });
    // Waiting on `status` alone is not enough: Firefox answers "complete" for the
    // about:blank a tab starts life as, before it has begun the navigation it was created
    // with, and the loop then falls through with nothing loaded. The URL is what says the
    // tab is the one that was asked for.
    let landed = null;
    for (let attempt = 0; attempt < 150; attempt++) {
      landed = await browser.tabs.get(tab.id);
      if (landed.url === url && landed.status === "complete") break;
      await sleep(100);
      landed = null;
    }
    if (!landed) throw new Error(`the tab for ${url} never loaded (last url: ${(await browser.tabs.get(tab.id)).url})`);
  }
  log(`opened ${urls.length} page(s)`);
}

async function group(urls, named) {
  const tabIds = await idsFor(urls);
  const groupId = await browser.tabs.group({ tabIds });
  if (named && browser.tabGroups) await browser.tabGroups.update(groupId, named);
  log(`grouped ${urls.length} tab(s) as ${JSON.stringify(named ?? null)} → ${groupId}`);
  return groupId;
}

/** The first-run settings land a moment after the background starts; ours must go on top. */
async function waitForFirstRun() {
  for (let attempt = 0; ; attempt++) {
    const { konode_settings: got } = await browser.storage.local.get("konode_settings");
    if (got?.device_id) return;
    if (attempt > 80) throw new Error("the extension never wrote its first-run settings");
    await sleep(250);
  }
}

const report = { role: config.role, userAgent: navigator.userAgent };

try {
  report.support = await support();
  Object.assign(report, await engineFacts());
  log(`tab group support: ${report.support}`);

  if (config.role !== "hello") {
    await waitForFirstRun();
    await send("SAVE_SETTINGS", config.settings);
    log("settings saved");
  }

  if (config.role === "publish") {
    const { work, reading, loose } = config.pages;
    await openPages([...work, ...reading, loose]);
    const [looseId] = await idsFor([loose]);
    await browser.tabs.update(looseId, { pinned: true });
    await group(work, config.named ? { title: "Work", color: "blue" } : null);
    await group(reading, config.named ? { title: "Reading", color: "red" } : null);
    await send("SYNC_NOW");
    log("published");
  }

  if (config.role === "receive") {
    await send("SYNC_NOW");
    const { konode_remote_sessions: raw } = await browser.storage.local.get("konode_remote_sessions");
    const entries = Array.isArray(raw) ? raw : Object.values(raw ?? {});
    const entry = entries.find((e) => e?.session?.tabs?.length);
    report.received = entry ? { device_id: entry.device_id, tabs: entry.session.tabs.length, id: entry.session.id } : null;
    if (!entry) throw new Error(`no peer session arrived (${entries.length} entr(ies) in storage)`);
    await send("RESTORE_SESSION", { id: entry.session.id });
    // The restore resolves once the tabs are open and grouped; this is only to let the
    // last `tabs.create` settle into `tabs.query`.
    await sleep(600);
    log("restored");
  }

  if (config.role !== "hello") {
    report.tabs = await tabsNow();
    report.groups = await groupsNow();
  }
} catch (err) {
  report.error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  log(`FAILED: ${report.error}`);
}

// text/plain keeps this a simple cross-origin request, so no preflight is needed.
await fetch(config.reportUrl, {
  method: "POST",
  headers: { "content-type": "text/plain" },
  body: JSON.stringify(report),
});
log("reported");
