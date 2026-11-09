// A static server for the capture run. The kinetic page needs the extension's own fonts
// and wordmark out of public/, and fetch() will not touch them over file://, so the two
// trees are stitched together here and nowhere else.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

export async function serve(root, extra = {}) {
  const mounts = {
    "/kinetic": resolve(root, "scripts/promo/kinetic"),
    "/text": resolve(root, "scripts/promo/text"),
    "/fonts": resolve(root, "public/fonts"),
    "/icons": resolve(root, "public/icons"),
    ...extra,
  };

  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const mount = Object.keys(mounts).find((m) => path === m || path.startsWith(`${m}/`));
    if (!mount) return res.writeHead(404).end("not mounted");
    const rest = path.slice(mount.length).replace(/^\/+/, "") || "index.html";
    const file = join(mounts[mount], rest);
    if (!file.startsWith(mounts[mount])) return res.writeHead(403).end("outside mount");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end(`not found: ${path}`);
    }
  });

  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(ok)) };
}
