import { useMemo, useState } from "react";
import { BookMarked, Copy, Plus, Sparkles, X } from "lucide-react";
import {
  addHotword,
  hotwordsStats,
  HOTWORDS_SOFT_LIMIT,
  parseHotwords,
  removeHotword,
  serializeHotwords,
  suggestHotwords,
} from "../analysis/hotwords";
import { Button, EmptyState, Input, Modal, Textarea } from "../ui/index";
import { copyToClipboard, toast } from "../ui";
import { useT } from "../i18n";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";

/**
 * 領域詞維護。
 *
 * 這跟「贅字管理」是相反的兩件事，設定裡放在一起會害人搞混：
 * - **領域詞**＝「請聽對這幾個字」，在辨識**之前**，影響逐字稿的內容。
 * - **贅字詞表**＝「這幾個字要剪掉」，在辨識**之後**，影響候選。
 *
 * 以前這裡只是設定裡一個逗號分隔的單行輸入框 —— 存得下，但編不動：
 * 看不出有幾個詞、刪中間那個要自己數逗號、貼一段進來還要手動改分隔符。
 *
 * 真正讓它有用的是**從逐字稿推薦**：沒有人憑空想得起來要加哪些字，
 * 但看到「你的節目裡『Tauri』被聽成三種東西、信心 0.2」就知道要加了。
 */
export default function HotwordsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const raw = useSettings((s) => s.s.hotwords);
  const save = useSettings((s) => s.save);
  const mediaId = useProject((s) => s.activeMediaId);
  const transcript = useTranscript((s) => (mediaId ? s.byMedia[mediaId] : undefined));
  const [draft, setDraft] = useState("");
  const [bulk, setBulk] = useState<string | null>(null);

  const words = useMemo(() => parseHotwords(raw), [raw]);
  const stats = hotwordsStats(words);
  const suggestions = useMemo(
    () => (transcript ? suggestHotwords(transcript.words, words) : []),
    [transcript, words],
  );

  const commit = async (next: string[]) => {
    await save({ hotwords: serializeHotwords(next) });
  };

  const add = async (value: string) => {
    if (!value.trim()) return;
    const before = words.length;
    const next = addHotword(words, value);
    await commit(next);
    setDraft("");
    if (next.length === before) toast.info(t("「{w}」已經在清單裡了", { w: value.trim() }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("領域詞")}
      icon={BookMarked}
      size="md"
      footer={
        <>
          <Button variant="ghost" icon={Copy} disabled={!words.length} onClick={() => void copyToClipboard(serializeHotwords(words), t("已複製"))}>
            {t("複製整份")}
          </Button>
          <Button variant="ghost" onClick={() => setBulk(bulk == null ? words.join("\n") : null)}>
            {bulk == null ? t("批次貼上 / 編輯") : t("回到清單")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("關閉")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-[11px] text-fg/50 leading-relaxed">
          {t("人名、產品名、公司名、技術術語 —— 辨識器聽不出來的那些。這是餵給辨識器的提示，影響逐字稿的內容；跟「贅字管理」（決定哪些字要剪掉）是相反的兩件事。")}
        </p>

        {bulk != null ? (
          <>
            <Textarea
              rows={12}
              value={bulk}
              spellCheck={false}
              placeholder={t("一行一個，或用逗號分隔；貼一整段進來也可以")}
              onChange={(e) => setBulk(e.target.value)}
              className="font-mono text-[12px] leading-6"
            />
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-fg/45">{t("{n} 個詞", { n: parseHotwords(bulk).length })}</span>
              <Button
                size="sm"
                variant="primary"
                className="ml-auto"
                onClick={() => {
                  void commit(parseHotwords(bulk));
                  setBulk(null);
                  toast.success(t("已更新領域詞"));
                }}
              >
                {t("套用")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
              <Input
                value={draft}
                placeholder={t("例如：Tauri、wavesurfer、某某科技")}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add(draft);
                }}
              />
              </span>
              <Button className="shrink-0 whitespace-nowrap" icon={Plus} disabled={!draft.trim()} onClick={() => void add(draft)}>
                {t("加入")}
              </Button>
            </div>

            {words.length === 0 ? (
              <EmptyState icon={BookMarked} title={t("還沒有領域詞")} hint={t("空著也沒關係 —— 只有辨識器聽不對的字才需要加。")} />
            ) : (
              <div className="flex flex-wrap gap-1 max-h-[30vh] overflow-y-auto">
                {words.map((w) => (
                  <span key={w} className="inline-flex items-center gap-1 rounded-sm bg-fg/8 pl-2 pr-1 h-6 text-[12px]">
                    {w}
                    <button
                      type="button"
                      aria-label={t("移除「{w}」", { w })}
                      title={t("移除「{w}」", { w })}
                      onClick={() => void commit(removeHotword(words, w))}
                      className="w-4 h-4 grid place-items-center rounded-sm text-fg/40 hover:text-danger hover:bg-fg/10"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-fg/45 tabular-nums">{t("{n} 個詞 · {c} 字元", { n: stats.count, c: stats.chars })}</span>
              {stats.overLimit && (
                <span className="text-warning">{t("超過 {n} 字元，辨識器可能只吃前面一段", { n: HOTWORDS_SOFT_LIMIT })}</span>
              )}
            </div>

            {/* 從這一集的低信心字推薦 —— 沒有人憑空想得起來要加哪些字 */}
            <div className="rounded-md border border-fg/10 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] text-fg/60">
                <Sparkles size={12} className="text-accent" />
                {t("從這一集挑（辨識信心低的字）")}
              </div>
              {!transcript ? (
                <div className="text-[11px] text-fg/40">{t("先分析一個音檔，這裡會列出辨識器沒把握的字。")}</div>
              ) : suggestions.length === 0 ? (
                <div className="text-[11px] text-fg/40">{t("這一集沒有明顯沒把握的字 —— 不用加也可以。")}</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {suggestions.map((s) => (
                    <button
                      key={s.text}
                      type="button"
                      title={t("出現 {n} 次 · 最低信心 {p}", { n: s.count, p: s.minProb.toFixed(2) })}
                      onClick={() => void add(s.text)}
                      className="inline-flex items-center gap-1 rounded-sm border border-accent/25 px-2 h-6 text-[12px] text-accent hover:bg-accent/10"
                    >
                      <Plus size={10} />
                      {s.text}
                      <span className="text-[10px] text-fg/40 tabular-nums">×{s.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
