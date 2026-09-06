import { useState } from "react";
import { Film, Play, Square, Star, Trash } from "lucide-react";
import { normalizeRanges, reelProblem, reelSourceMs, REEL_BED_GAIN_DB, REEL_CROSSFADE_MS } from "../analysis/reel";
import { Button, EmptyState, Field, IconButton, Input, Modal, Select } from "../ui/index";
import { useT } from "../i18n";
import { isRangePlaying, playRange, stopRange } from "../preview/playerRef";
import { useHighlights } from "../store/highlights";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";

/**
 * 精華片段清單 →「輸出精華合輯」。
 *
 * 一集剪完之後要丟社群的，通常不是一整段連續的 60 秒，而是散在各處的三五句。
 * 「只輸出這一段」處理不了那個 —— 這裡把挑好的幾段串成一支預告，專案完全不動。
 */
export default function HighlightsDialog({
  mediaId,
  onExport,
  onClose,
}: {
  mediaId: string;
  onExport: (bedMediaId: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const list = useHighlights((s) => s.byMedia[mediaId] ?? []);
  const update = useHighlights((s) => s.update);
  const remove = useHighlights((s) => s.remove);
  const setSelection = useTimeline((s) => s.setSelection);
  // isRangePlaying() 只說「有沒有在播某一段」，不說是哪一段，所以自己記
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [bed, setBed] = useState<string>("");
  // 墊樂只能挑「別的檔案」—— 拿這一集自己當底會聽到兩次自己
  const beds = useProject((s2) => s2.media.filter((m) => m.id !== mediaId));

  const merged = normalizeRanges(list);
  const problem = reelProblem(list);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("精華片段")}
      icon={Star}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button variant="primary" icon={Film} disabled={!!problem} onClick={() => onExport(bed || null)} title={problem ?? undefined}>
            {t("輸出精華合輯")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {list.length === 0 ? (
          <EmptyState
            icon={Star}
            title={t("還沒有精華片段")}
            hint={t("在波形上拖一段，按動作列的星號就會加進來。之後可以把這幾段串成一支預告。")}
          />
        ) : (
          <>
            <div className="text-xs text-fg/60">
              {t("{n} 段、素材共 {len} 秒；段落之間自動交越 {xf} ms。")
                .replace("{n}", String(merged.length))
                .replace("{len}", (reelSourceMs(list) / 1000).toFixed(1))
                .replace("{xf}", String(REEL_CROSSFADE_MS))}
              {merged.length < list.length && <span className="text-warning"> {t("（有重疊的段落會自動合併）")}</span>}
            </div>
            <div className="space-y-1 max-h-80 overflow-auto">
              {list.map((h, i) => {
                const playing = playingId === h.id && isRangePlaying();
                return (
                  <div key={h.id} className="flex items-center gap-2 rounded-md border border-fg/10 px-2 py-1.5">
                    <span className="mono text-[11px] text-fg/35 w-5 tabular-nums shrink-0">{i + 1}</span>
                    <IconButton
                      icon={playing ? Square : Play}
                      label={playing ? t("停止") : t("試聽這一段")}
                      onClick={() => {
                        if (playing) {
                          stopRange();
                          setPlayingId(null);
                        } else {
                          playRange(h.startMs, h.endMs, { skip: false });
                          setPlayingId(h.id);
                        }
                      }}
                    />
                    <Input
                      value={h.title ?? ""}
                      onChange={(e) => update(mediaId, h.id, { title: e.target.value })}
                      placeholder={t("（可以給它一個名字）")}
                      className="flex-1 min-w-0 h-7 text-[13px]"
                    />
                    <button
                      type="button"
                      onClick={() => setSelection({ startMs: h.startMs, endMs: h.endMs })}
                      title={t("在時間軸上選起來")}
                      className="mono text-[11px] text-fg/55 hover:text-accent tabular-nums shrink-0"
                    >
                      {formatMs(h.startMs, { millis: false })} · {((h.endMs - h.startMs) / 1000).toFixed(1)}s
                    </button>
                    <IconButton icon={Trash} label={t("移除")} className="text-danger" onClick={() => remove(mediaId, h.id)} />
                  </div>
                );
              })}
            </div>
          </>
        )}
        {list.length > 0 && (
          <Field label={t("墊樂（選用）")} hint={t("整支預告底下鋪同一首，頭尾自動淡進淡出，音量 {db} dB。").replace("{db}", String(REEL_BED_GAIN_DB))}>
            <Select value={bed} onChange={(e) => setBed(e.target.value)}>
              <option value="">{t("不加墊樂")}</option>
              {beds.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {list.length > 0 && beds.length === 0 && <div className="text-[11px] text-fg/40">{t("媒體清單裡只有這一個檔案，沒有東西可以當墊樂。")}</div>}
        {problem && list.length > 0 && <div className="text-xs text-warning">{problem}</div>}
      </div>
    </Modal>
  );
}
