import { useEffect, useState } from "react";
import { KEYS, type AuditEntry } from "@/lib/utils/storage";
import { sendMessage } from "@/lib/utils/messaging";
import { browser } from "@/lib/utils/ext";
import { CheckCircle2, XCircle, ChevronDown, Trash2 } from "lucide-react";

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void browser.storage.local.get(KEYS.AUDIT_LOG).then((result) => {
      setEntries((result[KEYS.AUDIT_LOG] as AuditEntry[]) ?? []);
    });
  }, [open]);

  const clearLog = async () => {
    await sendMessage({ type: "CLEAR_HISTORY" });
    setEntries([]);
  };

  return (
    <div className="mt-3.5 border-t border-sk-hairline pt-3.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between p-0.5 text-sk-subtle"
      >
        <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em]">Audit log</span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className="transition-transform duration-150"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      {open && (
        <div className="mt-2.5 space-y-1.5 animate-fade-in">
          {entries.length === 0 ? (
            <p className="py-2 text-center font-mono text-[12px] text-sk-subtle">No entries yet</p>
          ) : (
            <button
              onClick={clearLog}
              className="ml-auto flex items-center gap-1 text-[12px] text-sk-subtle transition-colors hover:text-sk-danger"
            >
              <Trash2 size={12} /> Clear log
            </button>
          )}
          {entries.slice(0, 20).map((e, i) => (
            <div key={`${e.timestamp}-${i}`} className="flex items-start gap-2 font-mono text-[12px]">
              {e.ok ? (
                <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-sk-signal" />
              ) : (
                <XCircle size={12} className="mt-0.5 shrink-0 text-sk-danger" />
              )}
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sk-text">{e.action}</span>
                {e.detail && <span className="block truncate text-sk-subtle">{e.detail}</span>}
              </div>
              <span className="shrink-0 tabular-nums text-sk-subtle">
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
