// Which build is this, and is it the one that was asked for?
//
// Konode ships two variants of the same version, and they are not interchangeable:
//
//   store   carries Konode's own Google OAuth client secret, compiled in at build time.
//           This is what goes to the Chrome Web Store and to AMO, so that Drive sign-in
//           works out of the box for people who install from a listing.
//   source  has no secret. This is what gets attached to a GitHub release, because a
//           release page is a public download and the secret must not be in it. Drive
//           sign-in in a source build needs an OAuth client of the user's own.
//
// Nothing about a finished zip records which one it is. Same filename, same manifest, same
// version, ~70 bytes apart in size. On 2026-08-17 both were built to the same path minutes
// apart, and for a while the file that had been pointed at as "ready for the store" was the
// source build, which breaks Drive sign-in for everyone who installs it. It was caught by
// luck rather than by anything in the tooling.
//
// So the tooling looks now. Every package run declares the variant it means to produce, the
// built output is read back, and a disagreement stops the run before anything is zipped.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const VARIANTS = ["store", "source"];

// Google OAuth client secrets are `GOCSPX-` followed by ~28 URL-safe characters.
//
// Matching the SHAPE rather than comparing against the value in .env is the entire point.
// The dangerous direction is a store build packaged on a machine where .env is missing or
// has been moved aside: there is no value left to compare against, the secret is still
// sitting in the bundle, and a value-based check would wave it through as "clean" and file
// it under source/ for publishing. A shape match needs nothing but the artifact.
const GOOGLE_CLIENT_SECRET = /GOCSPX-[A-Za-z0-9_-]{20,}/;

/** Every built script in the directory, background.js and the UI's hashed chunks alike. */
function bundlePaths(distDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".js")) out.push(p);
    }
  };
  walk(distDir);
  return out;
}

/**
 * Does this built directory carry a Google OAuth client secret ANYWHERE?
 *
 * Every .js, not just background.js, and that is not thoroughness for its own sake: the
 * secret really does land in two files. `gdrive-oauth.ts` reads it at module scope, and
 * Settings and the setup wizard both import `interactiveSignIn` from there, so Vite
 * inlines it into a UI chunk as well as into the service worker. A store build on this
 * machine puts it in `background.js` and in `chunks/theme-<hash>.js`.
 *
 * Reading one of the two left the check with a blind spot pointing the wrong way. Build
 * the worker with `--mode source` over a store `dist/` and background.js comes out clean
 * while the UI chunk still holds the secret, and this function would have answered "no
 * secret" and let the zip be filed under source/ for the release page. The npm scripts do
 * not currently produce that state, because the UI build runs first and empties the
 * directory. That is an argument about the order of two commands, which is not what a last
 * gate before publishing should be resting on.
 *
 * The chunk name is content-hashed, so it cannot be listed here either. Scan them all.
 */
export function hasSecret(distDir) {
  const worker = join(distDir, "background.js");
  if (!existsSync(worker)) {
    throw new Error(`${worker} not found — build before packaging.`);
  }
  return bundlePaths(distDir).some((p) => GOOGLE_CLIENT_SECRET.test(readFileSync(p, "utf8")));
}

/**
 * Read `--variant=store|source` off the command line. Defaults to `store`, because the
 * store build is the one a person runs by hand and the one where being wrong is only
 * inconvenient: a source build published to a store breaks Drive for its users, which is
 * bad, but a store build published to a release page puts the secret on the open web,
 * which is worse. The dangerous default is therefore the one nobody gets by accident.
 */
export function variantFromArgv(argv = process.argv.slice(2)) {
  const flag = argv.find((a) => a.startsWith("--variant="));
  const variant = flag ? flag.slice("--variant=".length) : "store";
  if (!VARIANTS.includes(variant)) {
    console.error(`Unknown variant "${variant}". Expected one of: ${VARIANTS.join(", ")}.`);
    process.exit(1);
  }
  return variant;
}

/**
 * Stop the run unless the built output matches the variant that was asked for.
 *
 * Exits rather than throws: this is the last gate before a zip exists, and a stack trace
 * buried in npm's output is easier to scroll past than a sentence saying what to do.
 */
export function assertVariant(distDir, variant) {
  const found = hasSecret(distDir);
  const want = variant === "store";

  if (found === want) {
    console.log(
      want
        ? "Verified: the OAuth secret is compiled in. This is a STORE build."
        : "Verified: no OAuth secret in the bundle. This is a SOURCE build."
    );
    return;
  }

  console.error(
    want
      ? [
          "Refusing to package: asked for a STORE build, but the bundle has no OAuth secret.",
          "",
          "A store build needs VITE_GOOGLE_CLIENT_SECRET, which lives in a gitignored .env.",
          "Without it, Drive sign-in fails for everyone who installs from the listing.",
          "Check that .env exists and holds the secret, then build again.",
        ].join("\n")
      : [
          "Refusing to package: asked for a SOURCE build, and the bundle HAS an OAuth secret.",
          "",
          "This zip was about to be published somewhere public with Konode's Google client",
          "secret inside it. The likely cause is a stale dist/ left by a store build: a source",
          "build must go through `--mode source`, which blanks the secret via .env.source.",
          "Run the source build again rather than packaging what is already there.",
        ].join("\n")
  );
  process.exit(1);
}

/**
 * Where a finished zip belongs. One directory per destination, so that picking the wrong
 * file means navigating to the wrong folder rather than just mistiming a rebuild:
 *
 *   web-ext-artifacts/chrome/   → upload to the Chrome Web Store
 *   web-ext-artifacts/firefox/  → upload to addons.mozilla.org
 *   web-ext-artifacts/source/   → attach to the GitHub release (both browsers)
 */
export function artifactDir(target, variant) {
  return variant === "source" ? "source" : target;
}
