import type { CSSProperties } from "react";
import type { BlockedBookmark } from "@/lib/types";
import { plural } from "@/lib/utils/i18n";

/**
 * A short list of bookmarks, title over address, with "and N more" under it when `total` is
 * larger than what is listed.
 *
 * Written for the blocked-deletion card in Settings → Activity (#23), which has to say which
 * bookmarks another device asked to remove, not only how many. Kept apart from that card,
 * and carrying its own styles like the exclusion tree, because the conflict screen (#35)
 * lists what differs between two devices the same way and sits right next to it.
 *
 * The addresses are text, not links. They came from another device's request, and a list
 * whose job is "do you recognize these?" has no business opening any of them.
 */
export function BookmarkList({ items, total }: { items: BlockedBookmark[]; total: number }) {
  if (!items.length) return null;
  const more = Math.max(0, total - items.length);
  return (
    <div style={S.wrap}>
      <ul style={S.list}>
        {items.map((b, i) => (
          // The index is part of the key: two bookmarks may share an address once clipped.
          <li key={`${i}:${b.url}`} style={S.item}>
            {b.title ? (
              <>
                <div style={S.title} dir="auto" title={b.title}>{b.title}</div>
                <div style={S.url} dir="ltr" title={b.url}>{b.url}</div>
              </>
            ) : (
              <div style={S.title} dir="ltr" title={b.url}>{b.url}</div>
            )}
          </li>
        ))}
      </ul>
      {more > 0 && <div style={S.more}>{plural("bm_list_more", more)}</div>}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  wrap: { marginTop: "var(--sp-sm)" },
  list: {
    listStyle: "none", margin: 0, padding: "var(--sp-2xs) 0",
    border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--bg-input)",
  },
  item: { padding: "var(--sp-2xs) var(--sp-md)", minWidth: 0 },
  title: {
    fontSize: "var(--fs-xs)", color: "var(--text-primary)",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  url: {
    fontSize: "var(--fs-xs)", color: "var(--text-secondary)",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  more: { fontSize: "var(--fs-xs)", color: "var(--text-secondary)", marginTop: "var(--sp-2xs)" },
};
