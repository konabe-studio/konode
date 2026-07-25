// Storage-provider brand marks, all inlined so there is NO external fetch (matches the
// privacy-first, no-external-request stance):
//   • Monochrome single-path marks (render in currentColor) from Simple Icons (MIT) —
//     Google Drive, Nextcloud, GitHub. viewBox 24x24.
//   • Full-color marks with their own palette (ignore the color prop) — pCloud.
// Providers with neither (Koofr, Fastmail) fall back to a fitting generic lucide icon
// until a brand SVG is dropped in.
import { Cloud, Server, Mail, Github } from "lucide-react";
import type { ProviderId } from "@/lib/storage-providers";

const BRAND: Partial<Record<ProviderId, string>> = {
  gdrive: "M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z",
  nextcloud: "M12.018 6.537c-2.5 0-4.6 1.712-5.241 4.015-.56-1.232-1.793-2.105-3.225-2.105A3.569 3.569 0 0 0 0 12a3.569 3.569 0 0 0 3.552 3.553c1.432 0 2.664-.874 3.224-2.106.641 2.304 2.742 4.016 5.242 4.016 2.487 0 4.576-1.693 5.231-3.977.569 1.21 1.783 2.067 3.198 2.067A3.568 3.568 0 0 0 24 12a3.569 3.569 0 0 0-3.553-3.553c-1.416 0-2.63.858-3.199 2.067-.654-2.284-2.743-3.978-5.23-3.977zm0 2.085c1.878 0 3.378 1.5 3.378 3.378 0 1.878-1.5 3.378-3.378 3.378A3.362 3.362 0 0 1 8.641 12c0-1.878 1.5-3.378 3.377-3.378zm-8.466 1.91c.822 0 1.467.645 1.467 1.468s-.644 1.467-1.467 1.468A1.452 1.452 0 0 1 2.085 12c0-.823.644-1.467 1.467-1.467zm16.895 0c.823 0 1.468.645 1.468 1.468s-.645 1.468-1.468 1.468A1.452 1.452 0 0 1 18.98 12c0-.823.644-1.467 1.467-1.467z",
  github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
};

// Full-color brand mark (its own palette — ignores the `color` prop). Supplied by the
// maintainer for a provider Simple Icons doesn't carry.
function PcloudMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#00bcd4" d="M9,24c0,0-0.258-0.961-0.258-2.289c0-1.593,0.331-3.964,1.258-5.601C4.36,16.847,0,21.658,0,27.5 C0,33.851,5.149,39,11.5,39S40,39,40,39V24H9z" />
      <path fill="#00bcd4" d="M24 9A15 15 0 1 0 24 39A15 15 0 1 0 24 9Z" />
      <path fill="#fff" d="M24,36c-6.617,0-12-5.383-12-12s5.383-12,12-12s12,5.383,12,12S30.617,36,24,36z M24,14 c-5.514,0-10,4.486-10,10s4.486,10,10,10s10-4.486,10-10S29.514,14,24,14z" />
      <path fill="#fff" d="M20.5,31c-0.829,0-1.5-0.672-1.5-1.5v-10c0-0.828,0.671-1.5,1.5-1.5h5c2.481,0,4.5,2.019,4.5,4.5 S27.981,27,25.5,27H22v2.5C22,30.328,21.329,31,20.5,31z M22,24h3.5c0.827,0,1.5-0.673,1.5-1.5S26.327,21,25.5,21H22V24z" />
      <path fill="#00bcd4" d="M45,22.5c0-3.59-2.91-6.5-6.5-6.5c-0.211,0-0.294-0.02-0.5,0c0.028,0.053-0.002-0.003,0,0 c0.929,1.637,1.258,4.117,1.258,5.711C39.258,23.039,39,24,39,24v4.975C42.355,28.719,45,25.921,45,22.5z" />
      <path fill="#00bcd4" d="M45.551,25.25C44.665,27.165,42.544,28,41.962,28C40.919,28,39,28,39,28v11c0.317-0.023,0.646,0,1,0 c4.418,0,8-3.582,8-8C48,28.74,47.059,26.703,45.551,25.25z" />
    </svg>
  );
}

// Fallback icon for providers without any inlined brand mark.
const FALLBACK: Record<ProviderId, typeof Cloud> = {
  gdrive: Cloud, nextcloud: Server, pcloud: Cloud, koofr: Cloud,
  fastmail: Mail, github: Github, webdav: Server,
};

export function ProviderLogo({ id, size = 16, color = "currentColor" }: { id: ProviderId; size?: number; color?: string }) {
  if (id === "pcloud") return <PcloudMark size={size} />; // full-color, own palette
  const path = BRAND[id];
  if (path) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
        <path d={path} />
      </svg>
    );
  }
  const Icon = FALLBACK[id];
  return <Icon size={size} color={color} />;
}
