import type { DataType } from "@/lib/types";
import { Bookmark, Clock, Layers, Globe, CheckCircle2, Puzzle } from "lucide-react";

interface Props {
  type: DataType;
  enabled: boolean;
  count: number;
}

const META: Record<DataType, { label: string; Icon: typeof Bookmark }> = {
  bookmarks:  { label: "Bookmarks",  Icon: Bookmark },
  history:    { label: "History",    Icon: Clock    },
  tabs:       { label: "Tabs",       Icon: Layers   },
  sessions:   { label: "Sessions",   Icon: Globe    },
  extensions: { label: "Extensions", Icon: Puzzle   },
};

export function DataTypeRow({ type, enabled, count }: Props) {
  const { label, Icon } = META[type];

  return (
    <div
      className={`
        flex items-center justify-between px-3 py-2 rounded-md
        transition-opacity ${enabled ? "opacity-100" : "opacity-35"}
      `}
    >
      <div className="flex items-center gap-2.5">
        <Icon
          size={13}
          className={enabled ? "text-accent/80" : "text-fg-subtle"}
        />
        <span className="text-xs text-fg-muted">{label}</span>
      </div>

      <div className="flex items-center gap-2">
        {count > 0 && (
          <span className="text-[10px] font-mono text-fg-subtle tabular-nums">
            ×{count}
          </span>
        )}
        {enabled
          ? <CheckCircle2 size={11} className="text-accent/60" />
          : <div className="w-[11px] h-[11px] rounded-full border border-border-strong" />
        }
      </div>
    </div>
  );
}
