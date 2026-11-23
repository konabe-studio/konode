import type { IBackend, BackendType, BackendConfig } from "@/lib/types";
import { GDriveBackend } from "./gdrive-backend";
import { GitHubBackend } from "./github-backend";
import { GiteaBackend } from "./gitea-backend";
import { DropboxBackend } from "./dropbox-backend";
import { WebDAVBackend } from "./webdav-backend";

export function createBackend(config: BackendConfig): IBackend {
  switch (config.type) {
    case "gdrive":  return new GDriveBackend(config);
    case "github":  return new GitHubBackend(config);
    case "gitea":   return new GiteaBackend(config);
    case "webdav":  return new WebDAVBackend(config);
    case "dropbox": return new DropboxBackend(config);
    default: {
      const _exhaustive: never = config.type;
      throw new Error(`Unknown backend type: ${_exhaustive}`);
    }
  }
}

export type { IBackend, BackendType };
