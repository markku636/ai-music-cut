// 時間軸索引（Final Cut 的 Timeline Index）。
//
// 一集 podcast 剪完會有幾十個接縫、幾個章節、一堆待辦，散在 40 分鐘的波形上。
// 波形只看得到「現在這一段」，找東西只能拖著捲軸掃 —— 索引把整條時間軸攤成一份
// 可以搜尋、可以篩選的清單，點一下就跳過去。章節在這裡改標題，因為那是會寫進
// 成品檔案的東西，不該只能在波形上用 tooltip 摸。
import { BookMarked, Check, Flag, ListTree, Plus, Scissors, Search, SquareDashed, Trash, Volume2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { AudioEffect } from "../analysis/effects";
import { effectLabel } from "../analysis/effects";
import { KIND_LABEL, MARKER_KIND_LABEL, type Candidate, type DecisionMap, type Marker, type MarkerKind } from "../analysis/types";
import { useT } from "../i18n";
import { playRange } from "../preview/playerRef";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";
import { useVirtual } from "../ui/useVirtual";
import type { SeamInfo } from "../timeline/trimActions";
import { Input } from "../ui/index";

type RowKind = "marker" | "chapter" | "todo" | "seam" | "candidate" | "effect";

interface Row {
  key: string;
  kind: RowKind;
  ms: number;
  label: string;
  sub?: string;
  marker?: Marker;
  seam?: SeamInfo;
}

const FILTERS: { id: RowKind | "all"; label: string; icon: typeof Flag }[] = [
  { id: "all", label: "全部", icon: ListTree },
  { id: "chapter", label: "章節", icon: BookMarked },
  { id: "marker", label: "標記", icon: Flag },
  { id: "todo", label: "待辦", icon: Check },
  { id: "seam", label: "接縫", icon: Scissors },
  { id: "effect", label: "效果", icon: Volume2 },
];

const ICONS: Record<RowKind, typeof Flag> = {
  marker: Flag,
  chapter: BookMarked,
  todo: Check,
  seam: Scissors,
  candidate: SquareDashed,
  effect: Volume2,
};

export default function IndexPanel({
  mediaId,
  seams,
  candidates,
  decisions,
  effects,
}: {
  mediaId: string | null;
  seams: SeamInfo[];
  candidates: Candidate[];
  decisions: DecisionMap;
  effects: AudioEffect[];
}) {
  const t = useT();
  const markers = useDecisions((s) => (mediaId ? s.markers[mediaId] ?? EMPTY_M : EMPTY_M));
  const updateMarker = useDecisions((s) => s.updateMarker);
  const removeMarker = useDecisions((s) => s.removeMarker);
  const seek = usePlayback((s) => s.seek);
  const addMarker = useDecisions((s) => s.addMarker);
  const currentMs = usePlayback((s) => s.currentMs);
  const setFocusSeam = useTimeline((s) => s.setFocusSeam);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<RowKind | "all">("all");
  const [editing, setEditing] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const m of markers) {
      const kind: RowKind = m.kind === "chapter" ? "chapter" : m.kind === "todo" ? "todo" : "marker";
      out.push({
        key: m.id,
        kind,
        ms: m.ms,
        label: m.title || t("（未命名{kind}）", { kind: MARKER_KIND_LABEL[m.kind] }),
        sub: m.note,
        marker: m,
      });
    }
    for (const s of seams) {
      const removed = Math.round(s.srcAfterMs - s.srcBeforeMs);
      out.push({
        key: `seam:${s.afterKeepId}:${Math.round(s.srcBeforeMs)}`,
        kind: "seam",
        ms: s.srcBeforeMs,
        label: s.splitId ? (s.gapMs > 0 ? t("切點 · 留白 {ms} ms", { ms: Math.round(s.gapMs) }) : t("切點")) : t("剪掉 {ms} ms", { ms: removed }),
        sub: s.kind,
        seam: s,
      });
    }
    for (const e of effects) {
      out.push({ key: e.id, kind: "effect", ms: e.startMs, label: effectLabel(e), sub: formatMs(e.endMs - e.startMs, { millis: false }) });
    }
    for (const c of candidates) {
      if ((decisions[c.id]?.state ?? "pending") !== "pending") continue;
      out.push({ key: c.id, kind: "candidate", ms: c.startMs, label: `${KIND_LABEL[c.kind]}`, sub: c.reason });
    }
    return out.sort((a, b) => a.ms - b.ms);
  }, [markers, seams, effects, candidates, decisions, t]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.kind !== filter) return false;
      if (!needle) return true;
      return (r.label + " " + (r.sub ?? "") + " " + formatMs(r.ms, { millis: false })).toLowerCase().includes(needle);
    });
  }, [rows, q, filter]);

  // 接縫 + 候選 + 效果會隨節目長度一起長：57 分鐘、一半候選被接受時，這份清單
  // 光是索引分頁就鋪了四萬九千個 DOM 節點，切過來要 719 毫秒。只畫看得到的那幾列。
  const shownKeys = useMemo(() => shown.map((r) => r.key), [shown]);
  const v = useVirtual(shownKeys, 40);
  const win = shown.slice(v.start, v.end);

  const go = (r: Row) => {
    seek(r.ms);
    playRange(Math.max(0, r.ms - 200), r.ms + 2500, { skip: true });
    if (r.kind === "seam") setFocusSeam(r.ms);
  };

  const counts = useMemo(() => {
    const m: Partial<Record<RowKind | "all", number>> = { all: rows.length };
    for (const r of rows) m[r.kind] = (m[r.kind] ?? 0) + 1;
    return m;
  }, [rows]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2 border-b border-fg/10 space-y-1.5">
        {/*
          在播放線新增。快捷鍵（M / Shift+M / Alt+M）本來就有，但只有看過說明的人知道 ——
          待辦尤其埋得深：類型、勾選、篩選都做好了，卻沒有任何地方能直接新增一個。
        */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-fg/35 mr-0.5">{t("在播放線新增")}</span>
          {(
            [
              { kind: "standard" as MarkerKind, icon: Flag, label: t("標記"), sc: "M" },
              { kind: "chapter" as MarkerKind, icon: BookMarked, label: t("章節"), sc: "Shift+M" },
              { kind: "todo" as MarkerKind, icon: Check, label: t("待辦"), sc: "Alt+M" },
            ]
          ).map((b) => (
            <button
              key={b.kind}
              type="button"
              disabled={!mediaId}
              onClick={() => mediaId && addMarker(mediaId, currentMs, b.kind)}
              title={`${b.label}（${b.sc}）`}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 h-6 text-[11px] text-fg/65 hover:bg-fg/10 hover:text-fg disabled:opacity-40 disabled:pointer-events-none"
            >
              <Plus size={11} />
              <b.icon size={12} />
              {b.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg/35" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("搜尋標記 / 章節 / 接縫…")} className="pl-7" />
          {q && (
            <button type="button" onClick={() => setQ("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg/35 hover:text-fg/70" aria-label={t("清除")}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const n = counts[f.id] ?? 0;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={
                  "h-6 px-1.5 rounded-sm text-[11px] inline-flex items-center gap-1 " +
                  (filter === f.id ? "bg-accent/15 text-accent" : n ? "text-fg/55 hover:bg-fg/5" : "text-fg/25")
                }
              >
                <f.icon size={11} />
                {t(f.label)}
                {n > 0 && <span className="mono tabular-nums text-[10px] opacity-70">{n}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={v.scrollRef} className="flex-1 min-h-0 overflow-auto">
        {shown.length === 0 ? (
          <div className="p-4 text-[12px] text-fg/40 leading-relaxed">
            {rows.length === 0 ? t("還沒有標記。按 M 下一個標記、Shift+M 下一個章節（章節會寫進成品檔案）。") : t("沒有符合的項目。")}
          </div>
        ) : (
          <ul>
            <li style={{ height: v.padTop }} />
            {win.map((r) => {
              const Icon = ICONS[r.kind];
              const isEditing = editing === r.key && r.marker;
              return (
                <li key={r.key} ref={v.measure(r.key)} className="border-b border-fg/5 hover:bg-fg/5 group">
                  <div className="flex items-start gap-1.5 px-2 py-1.5">
                    <Icon size={12} className={"mt-0.5 shrink-0 " + toneOf(r.kind)} />
                    <button type="button" onClick={() => go(r)} className="mono text-[11px] tabular-nums text-fg/45 hover:text-accent shrink-0 mt-px">
                      {formatMs(r.ms, { millis: false })}
                    </button>
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <Input
                          autoFocus
                          defaultValue={r.marker!.title}
                          placeholder={t("標題（章節會寫進成品）")}
                          onBlur={(e) => {
                            if (mediaId) updateMarker(mediaId, r.marker!.id, { title: e.target.value.trim() });
                            setEditing(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => (r.marker ? setEditing(r.key) : go(r))}
                          className={"block w-full text-left text-[12px] truncate " + (r.kind === "todo" && r.marker?.done ? "text-fg/35 line-through" : "text-fg/80")}
                          title={r.marker ? t("點一下改標題") : r.sub}
                        >
                          {r.label}
                        </button>
                      )}
                      {r.sub && !isEditing && <div className="text-[10px] text-fg/35 truncate">{r.sub}</div>}
                    </div>
                    {r.marker && (
                      <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0">
                        {r.kind === "todo" && (
                          <button
                            type="button"
                            title={t("做完了")}
                            onClick={() => mediaId && updateMarker(mediaId, r.marker!.id, { done: !r.marker!.done })}
                            className="p-1 rounded-sm text-fg/40 hover:text-emerald-400 hover:bg-fg/5"
                          >
                            <Check size={12} />
                          </button>
                        )}
                        <button
                          type="button"
                          title={t("移除")}
                          onClick={() => mediaId && removeMarker(mediaId, r.marker!.id)}
                          className="p-1 rounded-sm text-fg/40 hover:text-red-400 hover:bg-fg/5"
                        >
                          <Trash size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
            <li style={{ height: v.padBottom }} />
          </ul>
        )}
      </div>
    </div>
  );
}

function toneOf(k: RowKind): string {
  switch (k) {
    case "chapter":
      return "text-accent";
    case "todo":
      return "text-amber-400";
    case "seam":
      return "text-fg/40";
    case "effect":
      return "text-sky-400";
    default:
      return "text-fg/55";
  }
}

const EMPTY_M: Marker[] = [];

export type { MarkerKind };
