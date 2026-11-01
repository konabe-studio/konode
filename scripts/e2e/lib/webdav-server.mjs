// A WebDAV server the end-to-end pass syncs two real profiles through.
//
// The point of this pass is that nothing is staged: a tab group made in one browser has
// to travel through storage and come back out in another, over the extension's ordinary
// WebDAV path. This is that storage. It needs no account, no network and no secrets,
// which is what keeps the pass repeatable on anyone's machine, and it keeps every file in
// memory so a test can read the packet that was actually published.
//
// It is not a WebDAV implementation. It answers the five requests
// src/lib/backends/webdav-backend.ts actually makes, holds everything in memory, and
// takes any username and password. Do not point anything you care about at it.
//
// The promo pipeline (PR #68) carries the same server at
// scripts/promo/lib/webdav-server.mjs. Whichever of the two lands second should fold them
// into one shared helper rather than keep both.
import { createServer } from "node:http";

const DAV_HEADERS = {
  dav: "1, 2",
  "ms-author-via": "DAV",
  allow: "OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND",
};

const xmlEscape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function multistatus(entries) {
  const body = entries
    .map(({ href, collection, length }) => `
  <d:response>
    <d:href>${xmlEscape(href)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${xmlEscape(decodeURIComponent(href.split("/").filter(Boolean).pop() ?? ""))}</d:displayname>
        <d:resourcetype>${collection ? "<d:collection/>" : ""}</d:resourcetype>
        ${collection ? "" : `<d:getcontentlength>${length}</d:getcontentlength>`}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${body}\n</d:multistatus>\n`;
}

export async function startWebdav({ host = "127.0.0.1", port = 0 } = {}) {
  /** Collection paths, always stored with a trailing slash. */
  const collections = new Set(["/"]);
  /** File path to body. */
  const files = new Map();

  const asCollection = (path) => (path.endsWith("/") ? path : `${path}/`);
  const parentOf = (path) => asCollection(path.slice(0, path.lastIndexOf("/")) || "/");

  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const send = (status, body = "", headers = {}) =>
      res.writeHead(status, { ...DAV_HEADERS, ...headers }).end(body);

    if (req.method === "OPTIONS") return send(200);

    // Ask for credentials the way a real server does, then take whatever arrives. The
    // point is to exercise the extension's auth path, not to guard anything.
    if (!req.headers.authorization) {
      return send(401, "", { "www-authenticate": 'Basic realm="konode promo"' });
    }

    const isCollection = collections.has(asCollection(path));

    switch (req.method) {
      case "MKCOL": {
        if (isCollection || files.has(path)) return send(405);
        if (!collections.has(parentOf(path))) return send(409);
        collections.add(asCollection(path));
        return send(201);
      }

      case "PROPFIND": {
        const depth = req.headers.depth ?? "1";
        if (isCollection) {
          const here = asCollection(path);
          const entries = [{ href: here, collection: true }];
          if (depth !== "0") {
            for (const [file, body] of files) {
              if (parentOf(file) === here) entries.push({ href: file, length: body.length });
            }
          }
          return send(207, multistatus(entries), { "content-type": "application/xml; charset=utf-8" });
        }
        if (files.has(path)) {
          return send(207, multistatus([{ href: path, length: files.get(path).length }]), {
            "content-type": "application/xml; charset=utf-8",
          });
        }
        return send(404);
      }

      case "PUT": {
        if (!collections.has(parentOf(path))) return send(409);
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const existed = files.has(path);
          files.set(path, Buffer.concat(chunks));
          send(existed ? 204 : 201);
        });
        return undefined;
      }

      case "GET":
      case "HEAD": {
        const body = files.get(path);
        if (!body) return send(404);
        return send(200, req.method === "HEAD" ? "" : body, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(body.length),
        });
      }

      case "DELETE": {
        if (files.delete(path)) return send(204);
        if (collections.delete(asCollection(path))) {
          for (const file of [...files.keys()]) {
            if (file.startsWith(asCollection(path))) files.delete(file);
          }
          return send(204);
        }
        return send(404);
      }

      default:
        return send(405);
    }
  });

  await new Promise((ok) => server.listen(port, host, ok));
  const bound = server.address();
  return {
    origin: `http://${host}:${bound.port}`,
    files,
    names: () => [...files.keys()],
    close: () => new Promise((ok) => server.close(ok)),
  };
}
