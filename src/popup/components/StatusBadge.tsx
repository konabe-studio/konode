import type { SyncStatus } from "@/lib/types";

interface Props {
  status: SyncStatus;
  lastSync?: string | null;
}

const CONFIG: Record<SyncStatus, { label: string; dot: string; text: string }> = {
  idle:     { label: "Ready",      dot: "bg-fg-subtle",            text: "text-fg-muted"  },
  syncing:  { label: "Syncing…",   dot: "bg-warn animate-pulse",   text: "text-warn"      },
  success:  { label: "Synced",     dot: "bg-accent",               text: "text-accent"    },
  error:    { label: "Error",      dot: "bg-danger",               text: "text-danger"    },
  conflict: { label: "Conflict",   dot: "bg-warn animate-pulse",   text: "text-warn"      },
};

export function StatusBadge({ status, lastSync }: Props) {
  const cfg = CONFIG[status];

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
      </div>
      {lastSync && (
        <span className="text-[10px] font-mono text-fg-subtle tabular-nums">
          {lastSync}
        </span>
      )}
    </div>
  );
}
