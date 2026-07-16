// Rasterize public/icons/icon.svg into the PNG sizes the manifest references.
// Reproducible replacement for the old manual icon export — run after editing
// icon.svg:  npm run icons
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "public/icons/icon.svg"));
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const out = resolve(root, `public/icons/icon${size}.png`);
  // High render density → crisp downscale (the SVG is 256×256).
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  console.log(`wrote icons/icon${size}.png`);
}
