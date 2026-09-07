import { useEffect, useState } from "react";
import { meterAt, meterFraction, SILENCE_LUFS, verdict, type MeterReading } from "../analysis/meter";
import { useT } from "../i18n";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { getPlayer } from "./playerRef";
import { subscribeTick, TICK_PRIORITY } from "./ticker";

/**
 * 即時響度表（Audition / Reaper 那條一直在跳的 LUFS 表）。
 *
 * 響度本來只有兩個時機看得到：輸出後的驗收，以及逐段平衡的增益規劃表。剪的當下
 * 完全看不到 —— 「這一段是不是太小聲」只能憑耳朵，而耳朵會被系統音量騙。
 *
 * **讀的是來源的響度，不是成品的。** 成品還會經過逐段平衡、loudnorm 兩趟與限幅器，
 * 那個數字要等輸出後的驗收 —— 所以標題寫「來源」，不要讓人拿這個去對交件規範。
 *
 * 跟著共用 ticker 走，而且**只在播放時訂閱**：ticker 沒有訂閱者才會停，
 * 長期掛著等於暫停時也一直跑 rAF。
 */
export default function LoudnessMeter() {
  const t = useT();
  const mediaId = useProject((s) => s.activeMediaId);
  const targetLufs = useProject((s) => s.targetLufs);
  const local = useTranscript((s) => (mediaId ? s.local[mediaId] : undefined));
  const [r, setR] = useState<MeterReading | null>(null);

  useEffect(() => {
    if (!local) {
      setR(null);
      return;
    }
    // 位置一律從 <audio> 現讀：store 的位置是上一幀寫進去的，表會固定慢一幀
    const un = subscribeTick(() => {
      const el = getPlayer();
      if (!el) return;
      setR(meterAt(local, el.currentTime * 1000));
    }, TICK_PRIORITY.effects + 2);
    return un;
  }, [local]);

  if (!local || !r) return null;

  const v = verdict(r, targetLufs || -16);
  const tone =
    v === "silent" ? "text-fg/25" : v === "ok" ? "text-success" : v === "quiet" ? "text-warning" : "text-danger";
  const label =
    v === "silent" ? t("靜音") : v === "ok" ? t("接近目標") : v === "quiet" ? t("偏小聲") : t("偏大聲");
  const fmt = (x: number) => (x <= SILENCE_LUFS ? "—" : x.toFixed(1));

  return (
    <span
      className="flex items-center gap-1.5 shrink-0"
      title={t("來源響度（短期 3 秒 / 瞬間 400 毫秒）。目標 {tgt} LUFS。這是監看不是驗收 —— 成品還會經過逐段平衡與響度正規化。", {
        tgt: String(targetLufs || -16),
      })}
    >
      <span className="h-3 w-16 overflow-hidden rounded-sm bg-fg/10">
        <span
          className={`block h-full transition-[width] duration-100 ${
            v === "ok" ? "bg-success/70" : v === "quiet" ? "bg-warning/70" : v === "loud" ? "bg-danger/70" : "bg-fg/20"
          }`}
          style={{ width: `${Math.round(meterFraction(r.shortTerm) * 100)}%` }}
        />
      </span>
      <span className={`mono text-[11px] tabular-nums ${tone}`} aria-label={label}>
        {fmt(r.shortTerm)}
      </span>
      <span className="mono text-[10px] tabular-nums text-fg/30">{fmt(r.momentary)}</span>
    </span>
  );
}
