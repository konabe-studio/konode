import { useEffect, useState } from "react";
import type { AuditEntry } from "@/lib/utils/storage";
import { CheckCircle2, XCircle, ChevronDown, ChevronUp } from "lucide-react";

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    chrome.storage.local.get("synkro_audit", (result) => {
      setEntries((result["synkro_audit"] as AuditEntry[]) ?? []);
    });
  }, [open]);

  return (
    <div className="border-t border-border-subtle">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-2xs text-fg-subtle hover:text-fg-muted transition-colors"
      >
        <span className="font-mono uppercase tracking-wider">Audit Log</span>
        {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>

      {open && (
        <div className="px-4 pb-3 max-h-36 overflow-y-auto space-y-1 animate-fade-in">
          {entries.length === 0 && (
            <p className="text-2xs text-fg-subtle text-center py-2">No entries yet</p>
          )}
          {entries.slice(0, 20).map((e, i) => (
            <div
              key={i}
              className="flex items-start gap-2 py-1 border-b border-border-subtle/50 last:border-0"
            >
              {e.ok
                ? <CheckCircle2 size={9} className="text-accent/60 mt-0.5 shrink-0" />
                : <XCircle size={9} className="text-danger/60 mt-0.5 shrink-0" />
              }
              <div className="flex-1 min-w-0">
                <span className="text-[10px] font-mono text-fg-muted truncate block">
                  {e.action}
                </span>
                {e.detail && (
                  <span className="text-[10px] text-fg-subtle truncate block">
                    {e.detail}
                  </span>
                )}
              </div>
              <span className="text-[9px] font-mono text-fg-subtle shrink-0 tabular-nums">
                {new Date(e.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
