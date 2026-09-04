import { memo, useEffect, useMemo, useRef } from "react";
import { isActiveState, type Candidate, type DecisionMap, type Sentence, type Transcript, type Word } from "../analysis/types";
import { useT } from "../i18n";
import { usePlayback } from "../store/playback";
import { wordIndexAt } from "../store/transcript";
import { formatMs } from "../time";

export type WordMark = "cut" | "pending" | "";

export interface TranscriptEditorProps {
  transcript: Transcript | null;
  candidates: Candidate[];
  decisions: DecisionMap;
  selectedIds: string[];
  /** 單擊字：seek + 選取覆蓋它的候選。 */
  onWordClick: (wordId: number, candidateIds: string[]) => void;
  /** 雙擊字：切換剪 / 不剪（沒候選則新增手動剪除）。 */
  onWordToggle: (wordId: number) => void;
}

/**
 * 逐字稿：句子列 + 字 chip。劃線＝會被剪；虛框＝待決建議；點字 seek；雙擊直接剪 / 還原。
 */
export default function TranscriptEditor({ transcript, candidates, decisions, selectedIds, onWordClick, onWordToggle }: TranscriptEditorProps) {
  const t = useT();
  const currentMs = usePlayback((s) => s.currentMs);
  const follow = usePlayback((s) => s.follow);
  const seek = usePlayback((s) => s.seek);
  const listRef = useRef<HTMLDivElement>(null);

  const words = useMemo(() => transcript?.words ?? [], [transcript]);
  const activeIdx = useMemo(() => {
    const i = wordIndexAt(words, currentMs);
    return i >= 0 && words[i].endMs + 300 >= currentMs ? i : -1;
  }, [words, currentMs]);
  const activeWordId = activeIdx >= 0 ? words[activeIdx].id : -1;

  // 字 → 標記 / 覆蓋候選 / 理由
  const marks = useMemo(() => {
    const mark = new Map<number, WordMark>();
    const cov = new Map<number, string[]>();
    const reason = new Map<number, string>();
    for (const c of candidates) {
      const st = decisions[c.id]?.state ?? "pending";
      const m: WordMark = isActiveState(st) ? "cut" : st === "pending" ? "pending" : "";
      for (const id of c.wordIds) {
        const arr = cov.get(id) ?? [];
        arr.push(c.id);
        cov.set(id, arr);
        const prev = mark.get(id) ?? "";
        if (m === "cut" || (m === "pending" && prev !== "cut")) mark.set(id, m);
        if (m) reason.set(id, c.reason);
      }
    }
    return { mark, cov, reason };
  }, [candidates, decisions]);
  const selectedWordIds = useMemo(() => {
    const s = new Set<number>();
    for (const c of candidates) if (selectedIds.includes(c.id)) for (const id of c.wordIds) s.add(id);
    return s;
  }, [candidates, selectedIds]);

  const sentenceOf = useMemo(() => {
    const map = new Map<number, number>();
    transcript?.sentences.forEach((s) => s.wordIds.forEach((id) => map.set(id, s.id)));
    return map;
  }, [transcript]);
  const activeSentence = activeWordId >= 0 ? (sentenceOf.get(activeWordId) ?? -1) : -1;

  const lastScrolled = useRef(-1);
  useEffect(() => {
    if (!follow || activeSentence < 0 || activeSentence === lastScrolled.current) return;
    lastScrolled.current = activeSentence;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sid="${activeSentence}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [follow, activeSentence]);

  if (!transcript) {
    return <div className="flex-1 min-h-0 overflow-auto p-4 text-sm text-fg/40 leading-relaxed">{t("逐字稿（分析後顯示）")}</div>;
  }
  return (
    <div ref={listRef} className="flex-1 min-h-0 overflow-auto px-4 py-3 text-[15px] leading-7 select-none">
      {transcript.sentences.map((s) => (
        <SentenceRow
          key={s.id}
          sentence={s}
          words={words}
          activeWordId={activeWordId}
          isActive={s.id === activeSentence}
          marks={marks}
          selectedWordIds={selectedWordIds}
          onSeek={seek}
          onWordClick={onWordClick}
          onWordToggle={onWordToggle}
        />
      ))}
    </div>
  );
}

const SentenceRow = memo(function SentenceRow({
  sentence,
  words,
  activeWordId,
  isActive,
  marks,
  selectedWordIds,
  onSeek,
  onWordClick,
  onWordToggle,
}: {
  sentence: Sentence;
  words: Word[];
  activeWordId: number;
  isActive: boolean;
  marks: { mark: Map<number, WordMark>; cov: Map<number, string[]>; reason: Map<number, string> };
  selectedWordIds: Set<number>;
  onSeek: (ms: number) => void;
  onWordClick: (wordId: number, candidateIds: string[]) => void;
  onWordToggle: (wordId: number) => void;
}) {
  return (
    <div data-sid={sentence.id} className={`flex gap-3 rounded-md px-2 py-1 ${isActive ? "bg-accent/8" : ""}`}>
      <button type="button" onClick={() => onSeek(sentence.startMs)} className="mono text-[11px] text-fg/35 hover:text-accent shrink-0 pt-1.5 tabular-nums" title="跳到這句">
        {formatMs(sentence.startMs, { millis: false })}
      </button>
      <div className="min-w-0 flex-1 flex flex-wrap">
        {sentence.wordIds.map((id) => {
          const w = words[id];
          if (!w) return null;
          const m = marks.mark.get(id) ?? "";
          const cls = [
            "word-chip",
            id === activeWordId ? "word-chip--active" : "",
            m === "cut" ? "word-chip--cut" : m === "pending" ? "word-chip--pending" : "",
            selectedWordIds.has(id) ? "ring-1 ring-accent" : "",
            w.prob < 0.4 ? "word-chip--lowconf" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const reason = marks.reason.get(id);
          return (
            <span
              key={id}
              className={cls}
              onClick={() => onWordClick(id, marks.cov.get(id) ?? [])}
              onDoubleClick={(e) => {
                e.preventDefault();
                onWordToggle(id);
              }}
              title={`${formatMs(w.startMs)} · p=${w.prob.toFixed(2)}${reason ? `\n${reason}` : ""}\n雙擊：剪 / 還原`}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </div>
  );
});
