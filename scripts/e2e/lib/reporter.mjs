// Where the Firefox half sends what it found.
//
// The driver inside the extension cannot return a value to node, so it posts one here.
// Any origin may post: the extension page is `moz-extension://…`, which is cross-origin to
// everything, and the alternative is a host permission the shipped build asks for only
// when a user points it at a local server.
import { createServer } from "node:http";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

export async function startReporter({ host = "127.0.0.1", port = 0 } = {}) {
  const queued = [];
  const waiting = [];

  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
    if (req.method !== "POST") return res.writeHead(405, CORS).end();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        body = { error: `unparsable report: ${err.message}` };
      }
      res.writeHead(204, CORS).end();
      const next = waiting.shift();
      if (next) next(body);
      else queued.push(body);
    });
  });

  await new Promise((ok) => server.listen(port, host, ok));
  return {
    url: `http://${host}:${server.address().port}/report`,
    /** The next report, or a throw if Firefox never sends one. */
    next: (ms = 120_000) =>
      new Promise((ok, fail) => {
        if (queued.length) return ok(queued.shift());
        const timer = setTimeout(() => fail(new Error(`no report from the extension within ${ms}ms`)), ms);
        waiting.push((body) => { clearTimeout(timer); ok(body); });
      }),
    close: () => new Promise((ok) => server.close(ok)),
  };
}
