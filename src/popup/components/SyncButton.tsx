import { RefreshCw, Loader2 } from "lucide-react";

interface Props {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
}

export function SyncButton({ onClick, loading, disabled }: Props) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className={`
        w-full flex items-center justify-center gap-2
        py-2.5 rounded-lg text-sm font-medium
        transition-all duration-200 select-none
        ${!disabled
          ? "bg-accent text-surface-0 hover:bg-accent/90 active:scale-[0.98] shadow-glow-sm"
          : "bg-surface-3 text-fg-subtle cursor-not-allowed"
        }
        disabled:opacity-60
      `}
      aria-label={loading ? "Syncing in progress" : "Sync now"}
    >
      {loading
        ? <Loader2 size={14} className="animate-spin" />
        : <RefreshCw size={14} />
      }
      {loading ? "Syncing…" : "Sync Now"}
    </button>
  );
}
