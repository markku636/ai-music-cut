import { useCallback, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { correctAll, correctWord, occurrences } from "../analysis/correct";
import { addHotword, parseHotwords, serializeHotwords } from "../analysis/hotwords";
import { assignWords, sentenceSpeakers, speakerColor, type SpeakerState } from "../analysis/speakers";
import type { TextHit } from "../analysis/textSearch";
import type { Candidate, DecisionMap, Sentence } from "../analysis/types";
import { analyzeWithPreflight, openSettings } from "../commands/appActions";
import { useT } from "../i18n";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { useUi, type UiMode } from "../store/ui";
import WaveContextMenu, { type MenuItem } from "../timeline/WaveContextMenu";
import TranscriptEditor from "../transcript/TranscriptEditor";
import TranscriptPlaceholder from "../transcript/TranscriptPlaceholder";
import TranscriptSearch from "../transcript/TranscriptSearch";
import { toast, uiPrompt } from "../ui";

const EMPTY_C: Candidate[] = [];
const EMPTY_D: DecisionMap = {};
const EMPTY_SPK: SpeakerState = { list: [], turns: [] };

/**
 * 逐字稿區：搜尋列（專業）、講者篩選（專業）、逐字稿本體或分析前的佔位、字的右鍵。
 * 簡易與專業共用；簡易模式沒有搜尋列與講者篩選（那是找東西的工具，小白先不用）。
 */
export default function TranscriptArea({ variant }: { variant: UiMode }) {
  const t = useT();
  const simple = variant === "simple";
  const active = useProject(selectActiveMedia);
  const mediaId = active?.id ?? null;
  const transcript = useTranscript((s) => (mediaId ? s.byMedia[mediaId] ?? null : null));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY_C : EMPTY_C));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] ?? EMPTY_D : EMPTY_D));
  const speakers = useDecisions((s) => (mediaId ? s.speakers[mediaId] ?? EMPTY_SPK : EMPTY_SPK));
  const selectedIds = useDecisions((s) => s.selectedIds);
  const select = useDecisions((s) => s.select);
  const toggleWordCut = useDecisions((s) => s.toggleWordCut);
  const seek = usePlayback((s) => s.seek);
  const selection = useTimeline((s) => s.selection);
  const setSelection = useTimeline((s) => s.setSelection);
  const searchOpen = useUi((s) => s.transcriptSearch);
  const setSearchOpen = useUi((s) => s.setTranscriptSearch);
  // handler 要穩住識別，所以讀 ref 而不是把這兩個放進依賴
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const mediaIdRef = useRef(mediaId);
  mediaIdRef.current = mediaId;
  const anchorWord = useRef<number | null>(null);
  const [onlySpeaker, setOnlySpeaker] = useState<string | null>(null);
  const [wordMenu, setWordMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const [searchHits, setSearchHits] = useState<{ hits: TextHit[]; at: number }>({ hits: [], at: 0 });
  const hitWordIds = useMemo(() => new Set(searchHits.hits.flatMap((h) => h.wordIds)), [searchHits]);
  const activeHitWordIds = useMemo(() => new Set(searchHits.hits[searchHits.at]?.wordIds ?? []), [searchHits]);

  // 這四個 handler **一定要穩住識別**。
  //
  // 它們原本是寫在 JSX 裡的箭頭函式，父元件每次重繪都會產生新的一份 ——
  // 而父元件在播放線每動一次就會重繪。逐字稿的每一列都是 memo 的，但收到四個
  // 新函式之後 memo 一律失效：實測 57 分鐘的節目（1140 句），拖十次播放線產生
  // **22800 次列重繪**，等於每一格都把整份逐字稿重畫一遍。
  const onWordClick = useCallback(
    (wordId: number, cids: string[], shift: boolean) => {
      const tr = transcriptRef.current;
      const w = tr?.words[wordId];
      if (!tr || !w) return;
      if (shift && anchorWord.current != null && tr.words[anchorWord.current]) {
        const a = tr.words[anchorWord.current];
        setSelection({ startMs: Math.min(a.startMs, w.startMs), endMs: Math.max(a.endMs, w.endMs) });
        return;
      }
      anchorWord.current = wordId;
      seek(w.startMs);
      select(cids.slice(0, 1));
    },
    [seek, select, setSelection],
  );
  const onWordToggle = useCallback(
    (wordId: number) => {
      const tr = transcriptRef.current;
      const w = tr?.words[wordId];
      const id = mediaIdRef.current;
      if (!tr || !w || !id) return;
      const sid = tr.sentences.find((x) => x.wordIds.includes(wordId))?.id ?? -1;
      toggleWordCut(id, wordId, w, sid);
    },
    [toggleWordCut],
  );
  const onWordMenu = useCallback((id: number, x: number, y: number) => setWordMenu({ id, x, y }), []);
  const onSentenceSelect = useCallback((s: Sentence) => setSelection({ startMs: s.startMs, endMs: s.endMs }), [setSelection]);
  const onSearchHits = useCallback((hits: TextHit[], at: number) => setSearchHits({ hits, at }), []);

  // 講者標籤：段落 → 字 → 句。一句一個講者（換人的接縫上少數幾個字被串音判錯是常態，
  // 句層的多數決正好把它吸收掉），沒有標籤時整條路都不算。
  const sentenceSpeaker = useMemo(() => {
    if (!transcript || !speakers.turns.length) return undefined;
    return sentenceSpeakers(transcript.sentences, transcript.words, assignWords(transcript.words, speakers.turns));
  }, [transcript, speakers.turns]);

  /**
   * 修正辨識錯誤。**只改文字不動時間軸** —— 字的起訖是辨識器對出來的，
   * 改文字不代表那段聲音變了，所以剪輯決策與 EDL 完全不受影響。
   */
  const applyCorrection = async (wordId: number, all: boolean) => {
    if (!mediaId || !transcript) return;
    const w = transcript.words.find((x) => x.id === wordId);
    if (!w) return;
    const next = await uiPrompt(t("這個字實際上是什麼？"), { defaultValue: w.text.trim() });
    if (next == null) return;
    const r = all ? correctAll(transcript, wordId, next) : correctWord(transcript, wordId, next);
    if (!r.changed) return;
    useTranscript.getState().setTranscript(mediaId, r.transcript);
    useProject.getState().markDirty();
    const n = r.count;
    toast.success(t("已改成「{w}」（{n} 處）", { w: next.trim(), n }));
    // 修正是這一次，領域詞是下一次 —— 兩件事接起來才不用改第二遍
    const words = parseHotwords(useSettings.getState().s.hotwords);
    if (!words.some((x) => x.toLowerCase() === next.trim().toLowerCase())) {
      void useSettings.getState().save({ hotwords: serializeHotwords(addHotword(words, next)) });
      toast.info(t("順便加進領域詞，下一次辨識器就認得了"));
    }
  };

  const wordMenuItems = (wordId: number): MenuItem[] => {
    const w = transcript?.words.find((x) => x.id === wordId);
    const n = transcript ? occurrences(transcript, wordId) : 0;
    return [
      { label: w ? `「${w.text.trim()}」　p=${w.prob.toFixed(2)}` : String(wordId), disabled: true },
      { separator: true },
      { label: t("修正這個字…"), icon: Pencil, onClick: () => void applyCorrection(wordId, false) },
      ...(n > 1 ? [{ label: t("整份都改掉（{n} 處）…", { n }), icon: Pencil, onClick: () => void applyCorrection(wordId, true) } as MenuItem] : []),
    ];
  };

  if (!active) return null;

  return (
    <>
      {!simple && transcript && searchOpen && mediaId && (
        <TranscriptSearch mediaId={mediaId} transcript={transcript} onHits={onSearchHits} onClose={() => setSearchOpen(false)} />
      )}
      {!simple && transcript && speakers.list.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-fg/8 px-4 py-1.5">
          <span className="text-[11px] text-fg/40">{t("只看")}</span>
          <button
            type="button"
            onClick={() => setOnlySpeaker(null)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${onlySpeaker === null ? "border-accent bg-accent/12 text-accent" : "border-fg/15 text-fg/50 hover:bg-fg/5"}`}
          >
            {t("全部人")}
          </button>
          {speakers.list.map((sp) => {
            const on = onlySpeaker === sp.id;
            return (
              <button
                key={sp.id}
                type="button"
                onClick={() => setOnlySpeaker(on ? null : sp.id)}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "" : "border-fg/15 text-fg/50 hover:bg-fg/5"}`}
                style={on ? { borderColor: speakerColor(sp.colorIndex), color: speakerColor(sp.colorIndex), background: `${speakerColor(sp.colorIndex)}1f` } : undefined}
              >
                {sp.label}
              </button>
            );
          })}
          {onlySpeaker && <span className="text-[11px] text-fg/35">{t("（只是換一個看法，沒有動到剪輯）")}</span>}
        </div>
      )}
      {transcript ? (
        <TranscriptEditor
          onWordMenu={onWordMenu}
          transcript={transcript}
          candidates={candidates}
          decisions={decisions}
          selectedIds={selectedIds}
          selection={selection}
          onWordClick={onWordClick}
          onWordToggle={onWordToggle}
          onSentenceSelect={onSentenceSelect}
          hitWordIds={hitWordIds}
          activeHitWordIds={activeHitWordIds}
          sentenceSpeaker={sentenceSpeaker}
          speakers={speakers.list}
          onlySpeaker={onlySpeaker}
        />
      ) : (
        <TranscriptPlaceholder mediaId={mediaId} onAnalyze={() => analyzeWithPreflight()} onOpenSettings={(focus) => openSettings(focus ?? null)} />
      )}
      {wordMenu && <WaveContextMenu x={wordMenu.x} y={wordMenu.y} items={wordMenuItems(wordMenu.id)} onClose={() => setWordMenu(null)} />}
    </>
  );
}
