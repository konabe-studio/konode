// Pages for the tabs to be open on.
//
// A session only carries http(s) tabs (isSafeContentUrl), so the pass needs real pages at
// real URLs; it must not need the internet to get them. Each path answers with a document
// whose title is the path, which is what a tab's title ends up being and therefore what
// travels in the packet.
import { createServer } from "node:http";

export async function startPages({ host = "127.0.0.1", port = 0 } = {}) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\//, "") || "home";
    const safe = name.replace(/[<&]/g, "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${safe}</title></head><body><h1>${safe}</h1></body></html>`
    );
  });
  await new Promise((ok) => server.listen(port, host, ok));
  const origin = `http://${host}:${server.address().port}`;
  return {
    origin,
    url: (name) => `${origin}/${name}`,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
