// Seed data for the manual QA pass: a Netscape bookmark file, the format every browser's
// bookmark manager imports and exports.
//
// Sections U, V, W and Z of internal/QA_CHECKLIST.md want ~50 bookmarks on each of three
// devices before the interesting part starts, and building that by hand three times is the
// slowest part of the pass. Import this instead, once per profile, and the three devices
// start identical.
//
//   node scripts/make-qa-bookmarks.mjs                      50 loose + the folder set
//   node scripts/make-qa-bookmarks.mjs --count=5            section Y (under the floor of 20)
//   node scripts/make-qa-bookmarks.mjs --count=40 --flat    40 loose, no folders
//   node scripts/make-qa-bookmarks.mjs --out=some/where.html
//
// ADD_DATE is deliberately OLD (six months back by default, --age-days to change it).
// That is what a real browser backup carries, it is the whole of #27, and it is what
// section AB needs: import this file on A after a peer deleted some of it, and the
// bookmarks have to STAY. A file stamped today would pass AB without testing it.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);
const count = Number(args.get("count") ?? 50);
const ageDays = Number(args.get("age-days") ?? 180);
const flat = args.get("flat") === "true";
const out = resolve(process.cwd(), args.get("out") ?? `qa-bookmarks-${count}.html`);

if (!Number.isInteger(count) || count < 1) {
  console.error("--count must be a positive integer");
  process.exit(1);
}

// Seconds, not milliseconds: ADD_DATE in this format is a Unix timestamp in seconds, and a
// browser handed milliseconds files every bookmark in the year 56000.
const stamp = Math.floor((Date.now() - ageDays * 86_400_000) / 1000);

// Distinct hosts rather than paths on one host, so a bookmark is identifiable in a list of
// fifty at a glance and a canonical-URL collision cannot quietly merge two of them.
const link = (i, indent) =>
  `${indent}<DT><A HREF="https://site${i}.example/" ADD_DATE="${stamp + i}">B${i} site${i}</A>`;

const lines = [];
const open = (title, indent) => {
  lines.push(`${indent}<DT><H3 ADD_DATE="${stamp}">${title}</H3>`);
  lines.push(`${indent}<DL><p>`);
};
const close = (indent) => lines.push(`${indent}</DL><p>`);

let next = 0;
const take = (n, indent) => {
  for (let i = 0; i < n && next < count; i++) lines.push(link(next++, indent));
};

if (flat) {
  take(count, "    ");
} else {
  // The folder set section AA asks for: one folder holding bookmarks, one holding a
  // subfolder, and loose bookmarks BETWEEN the folders on the bar, which is what makes the
  // restore-order step (AC) answerable at all.
  take(Math.ceil(count * 0.3), "    ");
  open("Reading", "    ");
  take(Math.ceil(count * 0.2), "        ");
  close("    ");
  take(Math.ceil(count * 0.1), "    ");
  open("Work", "    ");
  take(Math.ceil(count * 0.15), "        ");
  open("Archive", "        ");
  take(Math.ceil(count * 0.15), "            ");
  close("        ");
  close("    ");
  take(count, "    "); // whatever is left, loose and last
}

const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- Konode QA seed: ${count} bookmarks, dated ${ageDays} days ago. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${stamp}" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
${lines.join("\n")}
    </DL><p>
</DL><p>
`;

writeFileSync(out, html, "utf8");
console.log(`wrote ${out}`);
console.log(`${count} bookmarks, ADD_DATE ${new Date(stamp * 1000).toISOString().slice(0, 10)}`);
console.log("import it from the browser's own bookmark manager, once per profile");
