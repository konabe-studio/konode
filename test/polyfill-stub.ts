// Test stub for `webextension-polyfill`. The real module throws at import time
// outside a browser-extension context, so vitest.config.ts aliases it here. The
// promise-based `chrome` fake from test/setup.ts already matches the polyfill's
// shape, so we just hand it back (both default and named `browser`).
export default (globalThis as unknown as { chrome: unknown }).chrome;
