import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs build script, no types, imported for what it guards.
import { hasSecret } from "./build-variant.mjs";

// The last gate before a zip is published. Getting it wrong in one direction ships a
// store build to a store without Konode's OAuth secret, so Drive sign-in fails for
// everyone who installs it. Getting it wrong in the OTHER direction puts that secret on
// a public release page, which is why the mixed case below is the one that matters.

const SECRET = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
const made: string[] = [];

function built(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "konode-variant-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hasSecret looks at every bundle, not just the worker", () => {
  it("finds a secret that is only in a UI chunk", () => {
    // The case the old check waved through. `gdrive-oauth.ts` reads the secret at module
    // scope and Settings imports from it, so Vite inlines it into a UI chunk as well as
    // into background.js. Building the worker with `--mode source` over a store dist/
    // leaves exactly this: a clean worker beside a chunk that still carries the secret,
    // certified "no secret" and filed under source/ for the release page.
    const dir = built({
      "background.js": "console.log('clean worker');",
      "chunks/theme-abc123.js": `const s="${SECRET}";`,
    });

    expect(hasSecret(dir)).toBe(true);
  });

  it("finds a secret in the worker alone", () => {
    const dir = built({
      "background.js": `const s="${SECRET}";`,
      "chunks/theme-abc123.js": "console.log('ui');",
    });

    expect(hasSecret(dir)).toBe(true);
  });

  it("answers no for a build that carries none", () => {
    const dir = built({
      "background.js": "console.log('clean');",
      "chunks/theme-abc123.js": "console.log('ui');",
    });

    expect(hasSecret(dir)).toBe(false);
  });

  it("is not fooled by a non-.js file, and does not read one", () => {
    // A locale or a source map mentioning the shape is not a compiled-in secret.
    const dir = built({
      "background.js": "console.log('clean');",
      "notes.txt": `this documents ${SECRET} and is not shipped code`,
    });

    expect(hasSecret(dir)).toBe(false);
  });

  it("refuses to answer for a directory that was never built", () => {
    const dir = built({ "chunks/theme-abc123.js": "console.log('ui');" });

    expect(() => hasSecret(dir)).toThrow(/build before packaging/i);
  });
});
