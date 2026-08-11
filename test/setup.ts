// Minimal chrome.* stub so modules that touch chrome.storage (logger/audit,
// storage helpers) and chrome.notifications can be imported and exercised under
// Vitest's Node environment. storage.local is a real in-memory store, cleared
// between tests. This file lives outside src/ so tsc/eslint don't check it.
import { vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const store = new Map();

// ─── chrome.bookmarks in-memory fake ───────────────────────────────────────
// Flat node map (id → node); the tree is materialized on demand. Models Chrome's
// virtual root "0" with the three stable roots: "1" bar, "2" other, "3" mobile.
let bmSeq = 100;
let alarmStore = new Map();
let bmNodes = new Map();

function resetBookmarks() {
  bmSeq = 100;
  bmNodes = new Map();
  bmNodes.set("0", { id: "0", parentId: undefined, title: "", index: 0 });
  [["1", "Bookmarks bar"], ["2", "Other bookmarks"], ["3", "Mobile bookmarks"]].forEach(
    ([id, title], i) => bmNodes.set(id, { id, parentId: "0", title, index: i })
  );
}
resetBookmarks();

// ─── chrome.history in-memory fake ─────────────────────────────────────────
//
// `__engine` selects which browser's addUrl semantics to model. Chrome's addUrl takes no
// visitTime at all and always stamps the visit NOW; Firefox's honors the one it is given.
// Konode's history sync turns on exactly that difference — it is how a visit that arrived
// from a peer is told apart from one the user made — so both have to be testable. The
// default is firefox, which is what the original tests were written against.
let histEntries = new Map();
const histApi = {
  __engine: "firefox",
  search: ({ maxResults } = {}) =>
    Promise.resolve([...histEntries.values()].slice(0, maxResults ?? Infinity)),
  addUrl: ({ url, visitTime }) => {
    // Chrome validates `details` STRICTLY and throws on an unknown property. It does not
    // quietly ignore visitTime, which the handler assumed for a long time — so on Chromium
    // virtually every page arriving from a peer was refused, and a bare catch hid it. The
    // fake accepted anything, which is why the suite never saw it.
    if (histApi.__engine === "chrome" && visitTime !== undefined) {
      return Promise.reject(new Error(
        "Error in invocation of history.addUrl(history.UrlDetails details, optional function callback): " +
        "Error at parameter 'details': Unexpected property: 'visitTime'."
      ));
    }
    // Browsers CANONICALIZE on write: a bare origin gains its trailing slash, the
    // host lowercases, a default port drops. The fake used to store the string
    // verbatim, which hid a re-add loop — the import de-duped on the raw peer string
    // while the browser had stored the normalized one, so the same URL was added as a
    // fresh visit on every single sync.
    let key = url;
    try { key = new URL(url).href; } catch { /* unparseable — store as given */ }
    const prev = histEntries.get(key);
    // The fake used to KEEP the previous time when no visitTime was passed, which is
    // neither engine — it made a plain user visit invisible in the timeline, so a
    // republish loop couldn't be observed at all.
    const stamp = histApi.__engine === "chrome" ? Date.now() : (visitTime ?? Date.now());
    histEntries.set(key, {
      id: key, url: key, title: "",
      lastVisitTime: stamp,
      // addUrl records a VISIT. The URL row already exists, so a repeat add doesn't
      // create a second row — it bumps the count. Modelling that is what makes a
      // re-add loop observable at all; a plain Map.set() just overwrote it silently.
      visitCount: (prev?.visitCount ?? 0) + 1,
    });
    return Promise.resolve();
  },
  // Lets one test play BOTH devices in turn: export here, wipe, replay the packet as the
  // other machine. A round trip is the only way to show a visit doesn't ping-pong.
  __reset: () => { histEntries = new Map(); },
};
function resetHistory() { histEntries = new Map(); histApi.__engine = "firefox"; }
resetHistory();

// ─── chrome.tabs / chrome.windows in-memory fake ───────────────────────────
//
// `__popupBlocked` models WebKit/Orion: the click buys ONE programmatic open and every
// one after it is SILENTLY swallowed — it resolves with a real-looking object and opens
// nothing. That silence is the whole difficulty; a thrown error would be easy.
//
// The allowance is spent by tabs.create AND windows.create alike, because it belongs to
// the user gesture, not to the method. An earlier version of this fake exempted
// windows.create ("one user-initiated action, so it is never blocked"), and that single
// wrong assumption is why a real regression stayed invisible: the code under test spent
// the allowance on the first tab and then rescued the rest with a windows.create that the
// fake always honoured and Orion always swallowed. The suite was green while a 10-tab
// session restored as 1 tab in the field.
let openTabs = [];
let windowsCreated = [];
let programmaticOpens = 0;
const allowanceSpent = () => tabsApi.__popupBlocked && programmaticOpens > 1;
const tabsApi = {
  __popupBlocked: false,
  query: () => Promise.resolve(openTabs.slice()),
  create: (props = {}) => {
    const t = { id: openTabs.length + 1, url: props.url, pinned: !!props.pinned, active: props.active ?? true };
    programmaticOpens++;
    if (allowanceSpent()) return Promise.resolve(t); // resolves, opens nothing
    openTabs.push(t);
    return Promise.resolve(t);
  },
};
const windowsApi = {
  create: (props = {}) => {
    const urls = Array.isArray(props.url) ? props.url : props.url != null ? [props.url] : [];
    programmaticOpens++;
    windowsCreated.push({ urls, focused: !!props.focused, blocked: allowanceSpent() });
    if (allowanceSpent()) return Promise.resolve({ id: 1, focused: !!props.focused, tabs: [] });
    const tabs = urls.map((u) => { const t = { id: openTabs.length + 1, url: u }; openTabs.push(t); return t; });
    return Promise.resolve({ id: 1, focused: !!props.focused, tabs });
  },
  __created: () => windowsCreated.slice(),
};
function resetTabs() {
  openTabs = [];
  windowsCreated = [];
  tabsApi.__popupBlocked = false;
  programmaticOpens = 0;
}
resetTabs();

function bmChildren(parentId) {
  return [...bmNodes.values()]
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function bmBuild(id) {
  const n = bmNodes.get(id);
  const node = { id: n.id, parentId: n.parentId, title: n.title, dateAdded: n.dateAdded, index: n.index };
  if (typeof n.url === "string") node.url = n.url;
  else node.children = bmChildren(id).map((c) => bmBuild(c.id));
  return node;
}

function makeBookmarks() {
  return {
    getTree: () => Promise.resolve([bmBuild("0")]),
    getChildren: (parentId) => Promise.resolve(bmChildren(parentId).map((c) => bmBuild(c.id))),
    create: (props) => {
      const siblings = bmChildren(props.parentId);
      // Chrome and Firefox REJECT an index past the child count ("Index out of
      // bounds."). The fake used to clamp it silently, which hid a real bug: the
      // merge passed a peer's absolute index into a smaller local parent, the create
      // threw, the handler's catch swallowed it, and the bookmark was never added —
      // on every sync. Reject like the browser so that can't hide again.
      if (typeof props.index === "number" && (props.index < 0 || props.index > siblings.length)) {
        return Promise.reject(
          new Error(`Index out of bounds. (index ${props.index}, ${siblings.length} children)`)
        );
      }
      const id = String(bmSeq++);
      const idx = typeof props.index === "number" ? props.index : siblings.length;
      for (const s of siblings) if ((s.index ?? 0) >= idx) s.index = (s.index ?? 0) + 1; // shift to insert
      const node = { id, parentId: props.parentId, title: props.title ?? "", dateAdded: Date.now(), index: idx };
      if (typeof props.url === "string") node.url = props.url;
      bmNodes.set(id, node);
      return Promise.resolve(bmBuild(id));
    },
    remove: (id) => {
      bmNodes.delete(id);
      return Promise.resolve();
    },
    removeTree: (id) => {
      const collect = (pid) => {
        for (const c of bmChildren(pid)) { collect(c.id); bmNodes.delete(c.id); }
      };
      collect(id);
      bmNodes.delete(id);
      return Promise.resolve();
    },
    move: (id, dest) => {
      const n = bmNodes.get(id);
      if (n && dest) {
        // Chrome keeps the node in its current parent when parentId is omitted
        // (a same-folder reorder), so default target to the node's current parent.
        const target = dest.parentId ?? n.parentId;
        // Model the real remove-then-insert: pull the node out, re-pack the rest to
        // contiguous indices, then splice in at the requested FINAL index. (dest.index
        // is the final-array position — Firefox's convention; the handler's moveToIndex
        // corrects Chromium's pre-removal-array quirk against the real browser.)
        const siblings = bmChildren(target).filter((s) => s.id !== id);
        const idx = typeof dest.index === "number" ? Math.max(0, Math.min(dest.index, siblings.length)) : siblings.length;
        siblings.splice(idx, 0, n);
        siblings.forEach((s, i) => { s.index = i; });
        n.parentId = target;
      }
      return Promise.resolve(n ? bmBuild(id) : undefined);
    },
    update: (id, changes) => {
      const n = bmNodes.get(id);
      if (n) {
        if (typeof changes.title === "string") n.title = changes.title;
        if (typeof changes.url === "string") n.url = changes.url;
      }
      return Promise.resolve(n ? bmBuild(id) : undefined);
    },
    getSubTree: (id) => Promise.resolve(bmNodes.has(id) ? [bmBuild(id)] : []),
    get: (idOrList) => {
      const ids = Array.isArray(idOrList) ? idOrList : [idOrList];
      return Promise.resolve(ids.filter((i) => bmNodes.has(i)).map((i) => bmBuild(i)));
    },
    onCreated: { addListener: () => {} },
    onChanged: { addListener: () => {} },
    onMoved: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
  };
}

function makeChrome() {
  return {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      // Desktop by default. lib/utils/capabilities asks this to work out whether the
      // browser can show a permission prompt at all (Firefox for Android can't), so the
      // fake has to answer — a test that wants the mobile answer overrides it.
      getPlatformInfo: () => Promise.resolve({ os: "win", arch: "x86-64" }),
    },
    // A browser where every permission is already held. That is what the manifest's
    // required permissions look like at runtime, and the optional ones are granted by
    // the same code path in every test that exercises a type needing one.
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
      getAll: () => Promise.resolve({ permissions: [], origins: [] }),
      remove: () => Promise.resolve(true),
    },
    // Present but empty. It exists at all because the capability checks read the API
    // surface to decide what this browser can sync, and a fake missing `management`
    // models a browser that cannot sync extensions — which is not what these tests mean.
    management: { getAll: () => Promise.resolve([]) },
    storage: {
      local: {
        get: (keys) => {
          const out = {};
          if (typeof keys === "string") {
            if (store.has(keys)) out[keys] = store.get(keys);
          } else if (Array.isArray(keys)) {
            for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          } else {
            for (const [k, v] of store) out[k] = v;
          }
          return Promise.resolve(out);
        },
        set: (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
          return Promise.resolve();
        },
        remove: (key) => {
          store.delete(key);
          return Promise.resolve();
        },
        // Real chrome.storage.local has this, and a test that plays two devices in turn
        // needs it to become the second machine mid-test.
        clear: () => {
          store.clear();
          return Promise.resolve();
        },
      },
    },
    bookmarks: makeBookmarks(),
    tabs: tabsApi,
    windows: windowsApi,
    history: histApi,
    notifications: { create: vi.fn() },
    // A real in-memory alarms registry, not a mock: the scheduling rule under test is
    // "don't recreate an alarm that already exists", which a create() stub can't show.
    alarms: {
      create: (name, info = {}) => {
        alarmStore.set(name, { name, ...info });
        return Promise.resolve();
      },
      get: (name) => Promise.resolve(alarmStore.get(name)),
      getAll: () => Promise.resolve([...alarmStore.values()]),
      clear: (name) => Promise.resolve(alarmStore.delete(name)),
      clearAll: () => { alarmStore.clear(); return Promise.resolve(true); },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    // Serves the REAL English messages, not a stub that echoes the key back. A fake that
    // always answers means a missing key still looks fine under test, which is the whole
    // failure mode i18n.test.ts exists to catch — so this behaves like the browser:
    // unknown key → empty string, and substitutions actually get substituted.
    i18n: {
      getMessage: (key, subs) => {
        const entry = enMessages[key];
        if (!entry) return "";
        const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
        let out = entry.message;
        for (const [name, ph] of Object.entries(entry.placeholders ?? {})) {
          const idx = Number(String(ph.content).replace("$", "")) - 1;
          out = out.replace(new RegExp("\\$" + name + "\\$", "gi"), list[idx] ?? "");
        }
        return out.replace(/\$(\d)/g, (_m, d) => list[Number(d) - 1] ?? "");
      },
      getUILanguage: () => "en",
    },
  };
}

// Read once at setup: the same file the extension ships.
const enMessages = JSON.parse(
  readFileSync(resolve(__dirname, "../public/_locales/en/messages.json"), "utf8")
);

/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).chrome = makeChrome();

// storage.ts computes DEFAULT_SETTINGS at module load via detectDeviceName(),
// which reads navigator.userAgent — not defined in Vitest's Node env (Node < 21).
if (typeof navigator === "undefined") {
  (globalThis as any).navigator = { userAgent: "Konode Test (Windows NT 10.0)" };
}

beforeEach(() => {
  store.clear();
  resetBookmarks();
  resetHistory();
  resetTabs();
  alarmStore = new Map();
});
