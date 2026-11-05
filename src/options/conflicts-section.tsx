import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ConflictDiff, ConflictItem } from "@/lib/types";
import { request } from "@/lib/utils/messaging";
import { t, plural, isolate } from "@/lib/utils/i18n";
import { BookmarkList } from "@/lib/ui/bookmark-list";
import { groupConflictsByDevice } from "@/popup/conflict-groups";

type DiffLoad =
  | { status: "loading" }
  | { status: "ok"; diff: ConflictDiff }
  | { status: "error"; message: string };

/**
 * Settings → Activity: the pending Manual conflicts, each with what differs (#35).
 *
 * The popup card asked "Keep local or Use remote?" with nothing on it about either version,
 * in a 360px window with no room to say. Its Resolve button brings you here, next to the
 * other decision Konode asks for about data you otherwise cannot see, the blocked deletion
 * (#23). Same buttons, same messages, so an answer given here is exactly the one the popup
 * would have given.
 *
 * The lists are asked for when the screen shows a card, not stored with it: they come from
 * opening the parked peer packet (a decrypt, with E2EE on) and from this device's data as
 * it is now. Answering one card asks again for the others, because Use remote changes this
 * device, and with it what a second device's card is about.
 */
export function ConflictsSection({ conflicts, onResolved }: {
  conflicts: ConflictItem[];
  /** Re-read the state once an answer went through, so the card goes away. */
  onResolved: () => Promise<void>;
}) {
  const [diffs, setDiffs] = useState<Record<string, DiffLoad>>({});
  // `${id}:${resolution}` while one answer is in flight. Every button waits on it, as in the
  // popup: two answers at once put two uploads of one file on the wire.
  const [resolving, setResolving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const comparable = conflicts.filter((c) => c.data_type === "bookmarks" || c.data_type === "history");
  const wanted = comparable.map((c) => c.id).filter((id) => !diffs[id]);

  useEffect(() => {
    if (!wanted.length) return;
    setDiffs((prev) => ({ ...prev, ...Object.fromEntries(wanted.map((id) => [id, { status: "loading" } as const])) }));
    for (const id of wanted) {
      void request({ type: "GET_CONFLICT_DIFF", payload: { id } }).then((sent) => {
        const load: DiffLoad = !sent.ok
          ? { status: "error", message: sent.error }
          : sent.res.type === "CONFLICT_DIFF"
            ? { status: "ok", diff: sent.res.payload }
            : { status: "error", message: t("opt_diff_failed") };
        setDiffs((prev) => (prev[id] ? { ...prev, [id]: load } : prev));
      });
    }
    // `wanted` is derived from these two; joining keeps the effect from re-running on every
    // render that builds an equal array.
  }, [wanted.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolve = async (c: ConflictItem, resolution: "local" | "remote") => {
    if (resolving) return;
    setResolving(`${c.id}:${resolution}`);
    setErrors((prev) => ({ ...prev, [c.id]: "" }));
    try {
      const sent = await request({ type: "RESOLVE_CONFLICT", payload: { id: c.id, resolution } });
      if (!sent.ok) setErrors((prev) => ({ ...prev, [c.id]: sent.error }));
      await onResolved();
      // Every card still up is compared again: this device may hold something new now.
      // After the state is re-read, so the card just answered is not asked about again.
      setDiffs({});
    } finally {
      setResolving(null);
    }
  };

  if (!conflicts.length) return null;
  return (
    <div className="settings-section">
      <div className="settings-card-head">
        {t("opt_conflicts_section")}
        <span className="head-sub">{t("opt_conflicts_section_sub")}</span>
      </div>
      <div className="settings-row">
        <div className="settings-row-left">
          <div className="row-desc">{t("opt_conflicts_explain", [t("popup_keep_local"), t("popup_use_remote")])}</div>
        </div>
      </div>
      {groupConflictsByDevice(conflicts).flat().map((c) => {
        const device = isolate(c.device_label || t("popup_unknown_device"));
        const load = diffs[c.id];
        return (
          // A column rather than the usual label-left, control-right row: the lists are the
          // point of this card and need its full width, so the answers sit on the heading
          // line and wrap under it when the window is narrow.
          <div key={c.id} className="settings-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div className="row-label" style={{ minWidth: 0 }}>
                {c.data_type === "history"
                  ? t("opt_conflict_history", device)
                  : c.data_type === "bookmarks"
                    ? t("opt_conflict_bookmarks", device)
                    : t(`datatype_${c.data_type}`)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <button className="btn-secondary" disabled={resolving !== null} onClick={() => void resolve(c, "local")}>
                  {resolving === `${c.id}:local` && <Loader2 size={12} className="spin" />} {t("popup_keep_local")}
                </button>
                <button className="btn-secondary" disabled={resolving !== null} onClick={() => void resolve(c, "remote")}>
                  {resolving === `${c.id}:remote` && <Loader2 size={12} className="spin" />} {t("popup_use_remote")}
                </button>
              </div>
            </div>
            {/* minWidth 0 lets a long address end in an ellipsis instead of widening the card. */}
            <div style={{ minWidth: 0 }}>
              {load?.status === "loading" && (
                <div className="row-desc"><Loader2 size={12} className="spin" /> {t("opt_diff_loading")}</div>
              )}
              {load?.status === "error" && (
                <div className="error-row" role="alert"><AlertTriangle size={12} /> {load.message}</div>
              )}
              {load?.status === "ok" && <DiffLists diff={load.diff} device={device} history={c.data_type === "history"} />}
              {errors[c.id] && (
                <div className="error-row" role="alert"><AlertTriangle size={12} /> {errors[c.id]}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DiffLists({ diff, device, history }: { diff: ConflictDiff; device: string; history: boolean }) {
  const { only_remote: theirs, only_local: mine, changed } = diff;
  if (!theirs.total && !mine.total && !changed) {
    return <div className="row-desc">{t(history ? "opt_diff_none_history" : "opt_diff_none_bookmarks")}</div>;
  }
  return (
    <>
      {theirs.total > 0 && (
        <div style={{ marginTop: "var(--sp-sm)" }}>
          <div className="row-desc">{t("opt_diff_only_remote", [device, String(theirs.total)])}</div>
          <BookmarkList items={theirs.sample} total={theirs.total} />
        </div>
      )}
      {mine.total > 0 && (
        <div style={{ marginTop: "var(--sp-sm)" }}>
          <div className="row-desc">{t("opt_diff_only_local", String(mine.total))}</div>
          <BookmarkList items={mine.sample} total={mine.total} />
        </div>
      )}
      {changed > 0 && (
        <div className="row-desc" style={{ marginTop: "var(--sp-sm)" }}>{plural("opt_diff_changed", changed)}</div>
      )}
    </>
  );
}
