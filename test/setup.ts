// Minimal chrome.* stub so modules that touch chrome.storage (logger/audit,
// storage helpers) and chrome.notifications can be imported and exercised under
// Vitest's Node environment. storage.local is a real in-memory store, cleared
// between tests. This file lives outside src/ so tsc/eslint don't check it.
import { vi, beforeEach } from "vitest";

const store = new Map();

// ─── chrome.bookmarks in-memory fake ───────────────────────────────────────
// Flat node map (id → node); the tree is materialized on demand. Models Chrome's
// virtual root "0" with the three stable roots: "1" bar, "2" other, "3" mobile.
let bmSeq = 100;
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
let histEntries = new Map();
function resetHistory() { histEntries = new Map(); }
resetHistory();

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
      const id = String(bmSeq++);
      const siblings = bmChildren(props.parentId);
      const idx = typeof props.index === "number" ? Math.min(props.index, siblings.length) : siblings.length;
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
        const siblings = bmChildren(target).filter((s) => s.id !== id);
        const idx = typeof dest.index === "number" ? Math.min(dest.index, siblings.length) : siblings.length;
        for (const s of siblings) if ((s.index ?? 0) >= idx) s.index = (s.index ?? 0) + 1; // shift to insert
        n.parentId = target;
        n.index = idx;
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
    runtime: { id: "test-extension-id", lastError: undefined },
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
      },
    },
    bookmarks: makeBookmarks(),
    tabs: { query: () => Promise.resolve([]), create: () => Promise.resolve({}) },
    history: {
      search: ({ maxResults } = {}) =>
        Promise.resolve([...histEntries.values()].slice(0, maxResults ?? Infinity)),
      addUrl: ({ url }) => { histEntries.set(url, { id: url, url, title: "", lastVisitTime: 1, visitCount: 1 }); return Promise.resolve(); },
    },
    notifications: { create: vi.fn() },
    alarms: { create: vi.fn(), clear: () => Promise.resolve(true) },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  };
}

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
});
