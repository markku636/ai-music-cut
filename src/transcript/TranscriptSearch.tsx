import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Scissors, Search, X } from "lucide-react";
import { fillerCandidates, findText, totalMs, type TextHit } from "../analysis/textSearch";
import { useT } from "../i18n";
import { usePlayback } from "../store/playback";
import { useDecisions } from "../store/decisions";
import { useTimeline } from "../store/timeline";
import { Button, IconButton } from "../ui/index";
import type { Transcript } from "../analysis/types";
import { formatMs } from "../time";

/**
 * 逐字稿搜尋列：找一個詞，然後把整集的它一次剪掉。
 *
 * 「剪掉某一句話」逐字稿本來就做得到（shift 點字選一段 → Delete）。
 * 這裡要解的是**重複**的那種 —— 整集 23 個「呃」，一個一個剪是這套工具最累的操作。
 */
export default function TranscriptSearch({
  mediaId,
  transcript,
  onHits,
  onClose,
}: {
  mediaId: string;
  transcript: Transcript;
  /** 把命中交給逐字稿畫底色；目前跳到第幾個也一起給。 */
  onHits: (hits: TextHit[], activeIdx: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seek = usePlayback((s) => s.seek);
  const setSelection = useTimeline((s) => s.setSelection);
  const addManualCuts = useDecisions((s) => s.addManualCuts);

  const hits = useMemo(() => findText(transcript, query), [transcript, query]);
  const fillers = useMemo(() => fillerCandidates(transcript), [transcript]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setAt(0), [query]);
  useEffect(() => onHits(hits, at), [hits, at, onHits]);
  // 收起來的時候要把底色一起收掉，不然剩下一堆黃字沒人負責
  useEffect(() => () => onHits([], 0), [onHits]);

  const go = (next: number) => {
    if (!hits.length) return;
    const i = ((next % hits.length) + hits.length) % hits.length;
    setAt(i);
    seek(hits[i].startMs);
    setSelection({ startMs: hits[i].startMs, endMs: hits[i].endMs });
  };

  const cutAll = () => {
    if (!hits.length) return;
    addManualCuts(
      mediaId,
      hits.map((h) => ({ startMs: h.startMs, endMs: h.endMs, wordIds: h.wordIds, sentenceId: h.sentenceId })),
      t("逐字稿搜尋：{q}").replace("{q}", query),
      t("剪掉全部「{q}」（{n}）").replace("{q}", query).replace("{n}", String(hits.length)),
    );
  };

  return (
    <div className="shrink-0 border-b border-line/60 bg-bg2/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <Search size={14} className="text-fg/40 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") go(e.shiftKey ? at - 1 : at + 1);
            e.stopPropagation();
          }}
          placeholder={t("在逐字稿裡找…（Enter 跳下一個）")}
          className="flex-1 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-fg/30"
        />
        {query.trim() !== "" && (
          <span className="mono text-[11px] text-fg/50 tabular-nums shrink-0">
            {hits.length ? `${at + 1} / ${hits.length} · ${formatMs(totalMs(hits), { millis: false })}` : t("沒有命中")}
          </span>
        )}
        <IconButton icon={ChevronUp} label={t("上一個（Shift+Enter）")} disabled={!hits.length} onClick={() => go(at - 1)} />
        <IconButton icon={ChevronDown} label={t("下一個（Enter）")} disabled={!hits.length} onClick={() => go(at + 1)} />
        <Button size="sm" variant="danger" icon={Scissors} disabled={!hits.length} onClick={cutAll} title={t("把命中的全部剪掉，一次 undo 就能還原")}>
          {t("全部剪掉（{n}）").replace("{n}", String(hits.length))}
        </Button>
        <IconButton icon={X} label={t("關閉搜尋（Esc）")} onClick={onClose} />
      </div>
      {fillers.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-fg/35 mr-0.5">{t("這集的口頭禪：")}</span>
          {fillers.slice(0, 8).map((f) => (
            <button
              key={f.query}
              type="button"
              onClick={() => setQuery(f.query)}
              className={`rounded-full px-2 py-0.5 text-[11px] tabular-nums transition-colors ${
                query === f.query ? "bg-accent/20 text-accent" : "bg-fg/6 text-fg/60 hover:bg-fg/12"
              }`}
            >
              {f.query} <span className="mono opacity-60">×{f.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
