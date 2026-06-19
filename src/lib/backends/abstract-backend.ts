import type { IBackend, BackendType, BackendConfig } from "@/lib/types";
import { GDriveBackend } from "./gdrive-backend";
import { GitHubBackend } from "./github-backend";
import { WebDAVBackend } from "./webdav-backend";

export function createBackend(config: BackendConfig): IBackend {
  switch (config.type) {
    case "gdrive":  return new GDriveBackend(config);
    case "github":  return new GitHubBackend(config);
    case "webdav":  return new WebDAVBackend(config);
    default: {
      const _exhaustive: never = config.type;
      throw new Error(`Unknown backend type: ${_exhaustive}`);
    }
  }
}

export type { IBackend, BackendType };
