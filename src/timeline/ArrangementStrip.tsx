import { useMemo } from "react";
import { arrangementBlocks, worthShowing, type ArrangementBlock } from "../analysis/arrangement";
import { mapOutToSrc, mapSrcToOut } from "../analysis/edl/map";
import { useT } from "../i18n";
import { edlFor } from "../pipeline/rules";
import { seekTo } from "../preview/playerRef";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { formatMs } from "../time";

/**
 * 成品順序帶：這一集**剪完之後**長什麼樣子。
 *
 * 上面的波形是**來源時間**的。只會「拿掉東西」的時候那樣剛好夠用，但剪下貼上 / 搬移
 * 之後來源時間軸就不再是節目了 —— 貼上的那一段在波形上完全看不到（它是同一段來源的
 * 第二份），搬移過的段落看起來還在原地。使用者做了一件事，畫面上沒有痕跡。
 *
 * 所以這一條照**成品順序**畫：一塊 = 成品裡連續的一段內容，點下去跳到它在來源的位置，
 * 貼上來的那幾塊標成另一個顏色、右鍵可以直接移除。
 *
 * 沒有東西可看的時候不佔高度（沒剪過的檔案只有一塊，畫出來是一條實心橫條）。
 */
const HEIGHT = 22;

export default function ArrangementStrip({ mediaId }: { mediaId: string | null }) {
  const t = useT();
  const currentMs = usePlayback((s) => s.currentMs);
  // 訂閱這三者：剪掉哪裡、貼了什麼、切在哪，任何一個變了編排就變了
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] : undefined));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] : undefined));
  const pastes = useDecisions((s) => (mediaId ? s.pastes[mediaId] : undefined));
  const splits = useDecisions((s) => (mediaId ? s.splits[mediaId] : undefined));
  const removePaste = useDecisions((s) => s.removePaste);

  const edl = useMemo(
    () => (mediaId ? edlFor(mediaId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mediaId, decisions, candidates, pastes, splits],
  );

  const blocks = useMemo(() => (edl ? arrangementBlocks(edl.keeps, edl.stats.outMs) : []), [edl]);

  if (!edl || !blocks.length || !worthShowing(blocks)) return null;

  const outMs = edl.stats.outMs;
  // 播放線在成品時間軸的位置。落在剪掉的區間時 mapSrcToOut 會靠到下一段的開頭。
  const playheadPct = outMs > 0 ? (mapSrcToOut(edl.keeps, currentMs) / outMs) * 100 : 0;

  const tip = (b: ArrangementBlock) => {
    const lines = [
      `${formatMs(b.outStartMs)} – ${formatMs(b.outEndMs)}（${t("成品")}）`,
      `${t("來源")} ${formatMs(b.srcStartMs)} – ${formatMs(b.srcEndMs)}`,
    ];
    if (b.pasteId) lines.push(t("貼上來的（右鍵可以移除）"));
    if (b.cutInsideMs > 0) lines.push(t("這一塊裡面剪掉了 {ms}", { ms: formatMs(b.cutInsideMs) }));
    return lines.join("\n");
  };

  return (
    <div data-strip="arrangement" className="relative w-full select-none border-t border-fg/8 bg-inset/40" style={{ height: HEIGHT }}>
      {/*
        絕對定位而不是 flex：保留段的成品時間之間不是完美接合的 —— crossfade 會讓
        前後重疊幾十毫秒，gap 接點會插入 room tone 留出一段空白。用 flex 依序排的話
        那些洞會被擠掉，整排往左縮（實測 3 塊只佔 98.8%），而播放線是照百分比絕對
        定位的，兩者就對不上了。照 outStartMs 放，洞就是洞（那裡真的是留白）。
      */}
      <div className="absolute inset-0">
        {blocks.map((b) => (
          <button
            key={b.index}
            type="button"
            data-block={b.pasteId ? "paste" : "keep"}
            title={tip(b)}
            aria-label={tip(b)}
            className={`absolute inset-y-0 border-r border-app/60 ${
              b.pasteId ? "bg-accent/55 hover:bg-accent/75" : "bg-fg/15 hover:bg-fg/25"
            }`}
            style={{ left: `${b.x * 100}%`, width: `max(1px, ${b.w * 100}%)` }}
            onClick={() => seekTo(b.srcStartMs)}
            onContextMenu={(e) => {
              if (!b.pasteId || !mediaId) return;
              // 只有貼上來的區塊有「移除」可做；其餘讓瀏覽器的預設選單過去
              e.preventDefault();
              removePaste(mediaId, b.pasteId);
            }}
          />
        ))}
      </div>
      {/* 播放線：這裡是成品時間，跟上面的波形不是同一個座標系 */}
      <div className="pointer-events-none absolute inset-y-0 w-px bg-accent" style={{ left: `${Math.min(100, Math.max(0, playheadPct))}%` }} />
      <span className="pointer-events-none absolute left-0.5 top-0.5 rounded-sm bg-app/70 px-1 text-[9px] leading-[11px] text-fg/40">
        {t("成品順序")}
      </span>
      <span className="pointer-events-none absolute right-0.5 top-0.5 rounded-sm bg-app/70 px-1 text-[9px] leading-[11px] tabular-nums text-fg/40">
        {formatMs(outMs)}
      </span>
    </div>
  );
}

/** 成品時間 → 來源時間（測試與外部用；元件內部點的是區塊的起點，不需要換算）。 */
export function srcAtStripFraction(keeps: Parameters<typeof mapOutToSrc>[0], outMs: number, fraction: number): number {
  return mapOutToSrc(keeps, Math.max(0, Math.min(1, fraction)) * outMs);
}
