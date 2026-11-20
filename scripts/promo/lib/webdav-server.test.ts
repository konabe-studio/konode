// The promo's WebDAV stand-in, driven by the extension's own WebDAV client.
//
// The video's central claim is that a bookmark written on one device arrives on another,
// so the server it syncs through has to be the real path, not a mock the test agrees
// with. These tests point the shipped WebDAVBackend at it and check that a packet
// written by one device is what the other device reads back.
import { describe, expect, it } from "vitest";
import { WebDAVBackend } from "@/lib/backends/webdav-backend";
import type { BackendConfig, SyncPacket } from "@/lib/types";
// @ts-expect-error -- plain .mjs, part of the promo tooling rather than the extension
import { startWebdav } from "./webdav-server.mjs";

const config = (url: string): BackendConfig => ({
  type: "webdav",
  label: "promo",
  enabled: true,
  webdav: { url, username: "promo", password: "promo", path: "konode" },
});

const packet = (device_id: string): SyncPacket => ({
  version: "1.0",
  device_id,
  timestamp: new Date().toISOString(),
  data_type: "bookmarks",
  checksum: "0".repeat(64),
  encrypted: false,
  payload: JSON.stringify({ from: device_id }),
});

async function withServer(fn: (origin: string, dav: { names: () => string[] }) => Promise<void>) {
  const dav = await startWebdav();
  try {
    await fn(dav.origin, dav);
  } finally {
    await dav.close();
  }
}

describe("the promo's local WebDAV server", () => {
  it("lets one device read what another device wrote", async () => {
    await withServer(async (origin) => {
      const a = new WebDAVBackend(config(origin));
      await a.connect();
      await a.upload(packet("device-a"));

      const b = new WebDAVBackend(config(origin));
      await b.connect(); // the folder is already there, which MKCOL answers with 405
      const packets = await b.downloadAll("bookmarks", "device-b");

      expect(packets.map((p) => p.device_id)).toEqual(["device-a"]);
      expect(JSON.parse(packets[0].payload)).toEqual({ from: "device-a" });
    });
  });

  it("does not hand a device its own packet back", async () => {
    await withServer(async (origin) => {
      const a = new WebDAVBackend(config(origin));
      await a.connect();
      await a.upload(packet("device-a"));

      expect(await a.downloadAll("bookmarks", "device-a")).toEqual([]);
    });
  });

  it("keeps each device's packet in its own file, and replaces it on the next sync", async () => {
    await withServer(async (origin, dav) => {
      const a = new WebDAVBackend(config(origin));
      await a.connect();
      await a.upload(packet("device-a"));
      await a.upload(packet("device-a"));
      const b = new WebDAVBackend(config(origin));
      await b.upload(packet("device-b"));

      expect(dav.names().sort()).toEqual([
        "/konode/konode_bookmarks_device-a.json",
        "/konode/konode_bookmarks_device-b.json",
      ]);
    });
  });

  it("reports an empty folder rather than failing when no peer has written yet", async () => {
    await withServer(async (origin) => {
      const a = new WebDAVBackend(config(origin));
      await a.connect();
      expect(await a.downloadAll("bookmarks", "device-a")).toEqual([]);
    });
  });
});
