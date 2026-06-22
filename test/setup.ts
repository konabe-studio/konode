// Minimal chrome.* stub so modules that touch chrome.storage (logger/audit,
// storage helpers) and chrome.notifications can be imported and exercised under
// Vitest's Node environment. storage.local is a real in-memory store, cleared
// between tests. This file lives outside src/ so tsc/eslint don't check it.
import { vi, beforeEach } from "vitest";

const store = new Map();

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
  (globalThis as any).navigator = { userAgent: "Synkro Test (Windows NT 10.0)" };
}

beforeEach(() => {
  store.clear();
});
