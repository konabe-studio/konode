import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reviewPageFor } from "./store-review";

describe("reviewPageFor", () => {
  it("sends a Web Store install to the Web Store reviews", () => {
    const page = reviewPageFor("mmlfiiimnpnjcjhhbldenpcmnibedkfa");
    expect(page?.store).toBe("Chrome Web Store");
    expect(page?.url).toMatch(/^https:\/\/chromewebstore\.google\.com\/detail\/konode\/mmlfiiimnpnjcjhhbldenpcmnibedkfa\/reviews$/);
  });

  it("sends a Firefox install to the AMO listing", () => {
    expect(reviewPageFor("konabe@proton.me")?.url).toBe("https://addons.mozilla.org/firefox/addon/konode/");
  });

  it("offers nothing for an install no store knows", () => {
    expect(reviewPageFor("ccndglojjbnpepoalfggnmdelbnacfli")).toBeNull(); // the local dev build
    expect(reviewPageFor("")).toBeNull();
  });

  // The gecko id is set by the Firefox manifest script, not in src. If it ever changed,
  // Firefox installs would silently lose the row, so hold the two to each other.
  it("knows the gecko id the Firefox build is given", () => {
    const script = readFileSync(resolve(__dirname, "../../scripts/make-firefox-manifest.mjs"), "utf8");
    const gecko = script.match(/GECKO_ID\s*=\s*["']([^"']+)["']/)?.[1];
    expect(gecko).toBeTruthy();
    expect(reviewPageFor(gecko!)).not.toBeNull();
  });
});
