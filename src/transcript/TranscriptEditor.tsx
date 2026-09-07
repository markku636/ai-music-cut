import { memo, useEffect, useMemo, useRef } from "react";
import { isActiveState, type Candidate, type DecisionMap, type Sentence, type Transcript } from "../analysis/types";
import { speakerColor, type Speaker } from "../analysis/speakers";
import { usePlayback } from "../store/playback";
import { wordIndexAt } from "../store/transcript";
import { formatMs } from "../time";
import { sameRow, type RowProps, type WordMark } from "./rowEquals";

export interface TranscriptEditorProps {
  transcript: Transcript | null;
  candidates: Candidate[];
  decisions: DecisionMap;
  selectedIds: string[];
  /** 單擊字：seek + 選取覆蓋它的候選；shift = 從上次點的字選到這個字（時間選取）。 */
  onWordClick: (wordId: number, candidateIds: string[], shift: boolean) => void;
  /** 雙擊字：切換剪 / 不剪（沒候選則新增手動剪除）。 */
  onWordToggle: (wordId: number) => void;
  /** 右鍵一個字（修正辨識錯誤）。 */
  onWordMenu?: (wordId: number, x: number, y: number) => void;
  /** 目前的時間選取（高亮落在範圍內的字）。 */
  selection?: { startMs: number; endMs: number } | null;
  /** 右鍵句子時間戳：把整句變成時間選取。 */
  onSentenceSelect?: (s: Sentence) => void;
  /** 搜尋命中的字（畫底色）；目前跳到的那一筆另外標起來。 */
  hitWordIds?: Set<number>;
  activeHitWordIds?: Set<number>;
  /** 句子 id → 講者 id（沒有講者標籤時不傳）。 */
  sentenceSpeaker?: Map<number, string>;
  speakers?: Speaker[];
  /** 只顯示這個講者說的句子（null = 全部）。 */
  onlySpeaker?: string | null;
}

/**
 * 逐字稿：句子列 + 字 chip。劃線＝會被剪；虛框＝待決建議；點字 seek；雙擊直接剪 / 還原。
 */
export default function TranscriptEditor({
  transcript,
  candidates,
  decisions,
  selectedIds,
  selection = null,
  onWordClick,
  onWordToggle,
  onWordMenu,
  onSentenceSelect,
  hitWordIds,
  activeHitWordIds,
  sentenceSpeaker,
  speakers,
  onlySpeaker = null,
}: TranscriptEditorProps) {
  const currentMs = usePlayback((s) => s.currentMs);
  const follow = usePlayback((s) => s.followMode !== "off");
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

  // 講者只在**換人的那一句**寫出名字。每一列都掛一次「Mark：」是雜訊，
  // 真正要一眼看出來的是「這裡換人了」。沒換人的列只留左邊的色條。
  const speakerById = useMemo(() => new Map((speakers ?? []).map((x) => [x.id, x])), [speakers]);
  const showName = useMemo(() => {
    const out = new Set<number>();
    if (!sentenceSpeaker || !transcript) return out;
    let prev: string | null = null;
    for (const s of transcript.sentences) {
      const id = sentenceSpeaker.get(s.id) ?? null;
      if (id && id !== prev) out.add(s.id);
      prev = id;
    }
    return out;
  }, [sentenceSpeaker, transcript]);

  if (!transcript) return null;

  // 「只看主持人講的話」：留著的句子時間戳還是原本的，點下去仍然跳到那句話在音檔裡的
  // 位置 —— 篩選只影響看得到什麼，**不影響剪輯**（不會因為篩掉就變成剪掉）。
  const rows = onlySpeaker && sentenceSpeaker ? transcript.sentences.filter((s) => sentenceSpeaker.get(s.id) === onlySpeaker) : transcript.sentences;
  return (
    <div ref={listRef} className="flex-1 min-h-0 overflow-auto px-4 py-3 text-[15px] leading-7 select-none">
      {onlySpeaker && rows.length === 0 && (
        <div className="px-2 py-6 text-center text-[12px] text-fg/40">{"—"}</div>
      )}
      {rows.map((s) => (
        <SentenceRow
          key={s.id}
          sentence={s}
          words={words}
          // **只把 activeWordId 傳給真的含有它的那一列。**
          // 傳給每一列的話，播放線每動一次、1140 個 memo 全部失效 ——
          // 實測 57 分鐘的節目每格要 274 毫秒（3.7 fps），而真正需要重畫的只有兩列。
          activeWordId={activeSentence === s.id ? activeWordId : -1}
          isActive={s.id === activeSentence}
          marks={marks}
          selectedWordIds={selectedWordIds}
          selection={selection}
          onSeek={seek}
          onWordClick={onWordClick}
          onWordToggle={onWordToggle}
          onWordMenu={onWordMenu}
          onSentenceSelect={onSentenceSelect}
          hitWordIds={hitWordIds}
          activeHitWordIds={activeHitWordIds}
          speaker={sentenceSpeaker ? (speakerById.get(sentenceSpeaker.get(s.id) ?? "") ?? null) : null}
          showSpeakerName={showName.has(s.id)}
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
  selection,
  onSeek,
  onWordClick,
  onWordToggle,
  onWordMenu,
  onSentenceSelect,
  hitWordIds,
  activeHitWordIds,
  speaker,
  showSpeakerName,
}: RowProps) {
  return (
    <div
      data-sid={sentence.id}
      data-speaker={speaker?.id}
      className={`flex gap-3 rounded-md px-2 py-1 ${isActive ? "bg-accent/8" : ""}`}
      style={speaker ? { borderLeft: `2px solid ${speakerColor(speaker.colorIndex)}`, paddingLeft: 6 } : undefined}
    >
      <button
        type="button"
        onClick={() => onSeek(sentence.startMs)}
        onContextMenu={(e) => {
          e.preventDefault();
          onSentenceSelect?.(sentence);
        }}
        className="mono text-[11px] text-fg/35 hover:text-accent shrink-0 pt-1.5 tabular-nums"
        title="點：跳到這句 · 右鍵：選取整句"
      >
        {formatMs(sentence.startMs, { millis: false })}
      </button>
      {speaker && showSpeakerName && (
        <span
          className="mono shrink-0 self-start rounded px-1 pt-0.5 text-[11px] font-medium"
          style={{ color: speakerColor(speaker.colorIndex), background: `${speakerColor(speaker.colorIndex)}1f` }}
          title={speaker.label}
        >
          {speaker.label}
        </span>
      )}
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
            selection && w.startMs < selection.endMs && w.endMs > selection.startMs ? "word-chip--sel" : "",
            activeHitWordIds?.has(id) ? "word-chip--hit word-chip--hit-active" : hitWordIds?.has(id) ? "word-chip--hit" : "",
            w.prob < 0.4 ? "word-chip--lowconf" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const reason = marks.reason.get(id);
          return (
            <span
              key={id}
              className={cls}
              onClick={(e) => onWordClick(id, marks.cov.get(id) ?? [], e.shiftKey)}
              onDoubleClick={(e) => {
                e.preventDefault();
                onWordToggle(id);
              }}
              onContextMenu={(e) => {
                if (!onWordMenu) return;
                e.preventDefault();
                onWordMenu(id, e.clientX, e.clientY);
              }}
              title={`${formatMs(w.startMs)} · p=${w.prob.toFixed(2)}${reason ? `\n${reason}` : ""}\n雙擊：剪 / 還原　右鍵：修正辨識`}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}, sameRow);
