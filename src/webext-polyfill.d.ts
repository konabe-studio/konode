// `webextension-polyfill` ships no bundled types. We consume it only through
// lib/utils/ext.ts, which casts the default export to `typeof chrome`, so a
// minimal module declaration is all TypeScript needs here. We deliberately avoid
// `@types/webextension-polyfill`: it declares a global `browser` namespace that
// clashes with `@types/chrome`, and we don't need its API surface given the cast.
declare module "webextension-polyfill" {
  const browser: unknown;
  export default browser;
}
