import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Bookmark, ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { BookmarkExclusion } from "@/lib/types";
import { browser } from "@/lib/utils/ext";
import { plural, t } from "@/lib/utils/i18n";
import { pickStates, toggleExclusion, type ExclusionNode, type PickState } from "@/lib/utils/bookmark-exclusions";

/**
 * This browser's bookmark tree with a box in front of every folder and bookmark, for picking
 * what this device keeps out of sync (#54). Shared by the setup wizard and Settings, which
 * style the switch that opens it each their own way; this part carries its own styles so it
 * looks the same in both.
 *
 * Folders open one level at a time, and a folder shows its first SHOW_AT_ONCE entries with a
 * button for the rest: the folder people come here to exclude is the one with thousands of
 * bookmarks in it, and drawing all of them at once would freeze this page instead.
 */

const SHOW_AT_ONCE = 200;

interface Props {
  value: BookmarkExclusion[];
  onChange: (next: BookmarkExclusion[]) => void;
}

interface Row {
  node: ExclusionNode;
  depth: number;
  /** A "show more" row for the folder `node`, holding how many are still hidden. */
  more?: number;
}

/** Bookmarks inside each folder, at any depth. */
function countBookmarks(tree: ExclusionNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (n: ExclusionNode): number => {
    if (n.url) return 1;
    let total = 0;
    for (const c of n.children ?? []) total += walk(c);
    counts.set(n.id, total);
    return total;
  };
  tree.forEach(walk);
  return counts;
}

export function BookmarkExclusionTree({ value, onChange }: Props) {
  const [tree, setTree] = useState<ExclusionNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let live = true;
    browser.bookmarks.getTree().then(
      (nodes) => {
        if (!live) return;
        setTree(nodes as ExclusionNode[]);
        // The roots open, everything under them closed: the first screen is the list of
        // top-level folders, which is where an extension's folder sits.
        setOpen(new Set((nodes[0]?.children ?? []).map((r) => r.id)));
      },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { live = false; };
  }, []);

  const states = useMemo(() => (tree ? pickStates(tree, value) : new Map<string, PickState>()), [tree, value]);
  const counts = useMemo(() => (tree ? countBookmarks(tree) : new Map<string, number>()), [tree]);
  const roots = useMemo(() => tree?.[0]?.children ?? [], [tree]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (n: ExclusionNode, depth: number): void => {
      out.push({ node: n, depth });
      if (n.url || !open.has(n.id)) return;
      const kids = n.children ?? [];
      const limit = shown.get(n.id) ?? SHOW_AT_ONCE;
      kids.slice(0, limit).forEach((c) => walk(c, depth + 1));
      if (kids.length > limit) out.push({ node: n, depth: depth + 1, more: kids.length - limit });
    };
    roots.forEach((r) => walk(r, 0));
    return out;
  }, [roots, open, shown]);

  const toggleOpen = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (error) return <div style={S.note} role="alert">{t("bm_exclude_error", error)}</div>;
  if (!tree) return <div style={S.note}>{t("bm_exclude_loading")}</div>;
  if (!roots.some((r) => (r.children ?? []).length)) return <div style={S.note}>{t("bm_exclude_empty")}</div>;

  return (
    <div>
      <div style={S.panel}>
        {rows.map(({ node, depth, more }) => {
          const indent = { paddingInlineStart: 8 + depth * 18 };
          if (more !== undefined) {
            return (
              <div key={`${node.id}:more`} style={{ ...S.row, ...indent }}>
                <span style={S.chevronSpace} />
                <button
                  type="button" style={S.more}
                  onClick={() => setShown((prev) => new Map(prev).set(node.id, (prev.get(node.id) ?? SHOW_AT_ONCE) + SHOW_AT_ONCE))}
                >
                  {plural("bm_exclude_more", Math.min(more, SHOW_AT_ONCE))}
                </button>
              </div>
            );
          }
          const isFolder = !node.url;
          const state = states.get(node.id) ?? "off";
          const title = node.title || node.url || t("bm_exclude_untitled");
          const hasKids = isFolder && (node.children ?? []).length > 0;
          const expanded = open.has(node.id);
          return (
            <div key={node.id} style={{ ...S.row, ...indent }}>
              {hasKids ? (
                <button
                  type="button" style={S.chevron} aria-expanded={expanded}
                  aria-label={t(expanded ? "bm_exclude_collapse" : "bm_exclude_expand", title)}
                  onClick={() => toggleOpen(node.id)}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : <span style={S.chevronSpace} />}
              <label style={S.label} title={node.url}>
                <input
                  type="checkbox" style={S.checkbox}
                  checked={state === "on"}
                  // Partly ticked has no attribute, only this property.
                  ref={(el) => { if (el) el.indeterminate = state === "mixed"; }}
                  onChange={(e) => onChange(toggleExclusion(tree, value, node.id, e.target.checked))}
                />
                {isFolder
                  ? <Folder size={14} color="var(--text-secondary)" style={S.icon} />
                  : <Bookmark size={14} color="var(--text-secondary)" style={S.icon} />}
                <span style={S.title}><bdi>{title}</bdi></span>
                {isFolder && <span style={S.count}>{plural("bm_exclude_count", counts.get(node.id) ?? 0)}</span>}
              </label>
            </div>
          );
        })}
      </div>
      <div style={S.summary}>
        {value.length ? plural("bm_exclude_summary", value.length) : t("bm_exclude_none")}
      </div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  panel: {
    maxHeight: 320, overflowY: "auto",
    border: "1px solid var(--border)", borderRadius: 8,
    background: "var(--bg-input)", padding: "4px 0",
  },
  row: { display: "flex", alignItems: "center", gap: 4, minHeight: 28, paddingInlineEnd: 8 },
  chevron: {
    width: 20, height: 20, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-secondary)", borderRadius: 4,
  },
  chevronSpace: { width: 20, flexShrink: 0 },
  label: { display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, cursor: "pointer", fontSize: 13, color: "var(--text-primary)" },
  checkbox: { margin: 0, flexShrink: 0, accentColor: "var(--accent)", cursor: "pointer" },
  icon: { flexShrink: 0 },
  title: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  count: { flexShrink: 0, fontSize: 11, color: "var(--text-secondary)" },
  more: {
    background: "none", border: "none", padding: "2px 0", cursor: "pointer",
    fontSize: 12, color: "var(--text-link)", fontFamily: "inherit",
  },
  summary: { fontSize: 12, color: "var(--text-secondary)", marginTop: 6 },
  note: { fontSize: 12, color: "var(--text-secondary)", padding: "8px 0" },
};
