// 精準修剪器（Final Cut 的 Precision Editor）。
//
// 巡接縫只能告訴你「這一刀聽起來怪」，改不了。這個面板把一刀攤開來看：
// 上排是來源（被剪掉的那一段打斜線），下排是剪完之後真正會聽到的接法，
// 兩排同一個 ms/px 比例，所以「吃掉了半個字」用看的就看得出來。
//
// 追接縫用位置不用 afterKeepId —— keep 是推導出來的，修剪完編號就重排了。
import { ChevronLeft, ChevronRight, Play, Repeat, Scissors, Trash, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalAnalysis } from "../analysis/peaks";
import type { Transcript } from "../analysis/types";
import { useT } from "../i18n";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";
import { removeSeamSplit, setSeamPause, trimSeam, type SeamInfo } from "../timeline/trimActions";
import { IconButton } from "../ui/index";
import { playRange } from "./playerRef";

/** 接縫兩側各看多久。1.2 秒大約是一個短句，剛好聽得出接得順不順。 */
const WINDOW_MS = 1200;
const LANE_H = 46;
const PAUSE_STEPS = [0, 200, 500, 1000];

function drawLane(
  ctx: CanvasRenderingContext2D,
  a: LocalAnalysis,
  fromMs: number,
  toMs: number,
  x0: number,
  w: number,
  y: number,
  h: number,
  color: string,
) {
  const mid = y + h / 2;
  ctx.fillStyle = color;
  const span = toMs - fromMs;
  if (span <= 0 || w <= 0) return;
  for (let px = 0; px < w; px++) {
    const ms = fromMs + (px / w) * span;
    const b = Math.round((ms / 1000) * a.pps);
    if (b < 0 || b >= a.nBuckets) continue;
    const lo = (a.mins[b] / 127) * (h / 2);
    const hi = (a.maxs[b] / 127) * (h / 2);
    const top = mid - Math.max(hi, 0.5);
    const bot = mid - Math.min(lo, -0.5);
    ctx.fillRect(x0 + px, top, 1, Math.max(1, bot - top));
  }
}

export default function PrecisionTrim({
  seams,
  analysis,
  transcript,
}: {
  seams: SeamInfo[];
  analysis: LocalAnalysis | null;
  transcript: Transcript | null;
}) {
  const t = useT();
  const focusMs = useTimeline((s) => s.focusSeamMs);
  const setFocusSeam = useTimeline((s) => s.setFocusSeam);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loop, setLoop] = useState(true);
  const [nudge, setNudge] = useState(10);

  // 用位置找目前這一刀（id 會因為重新編號而失效）
  const index = useMemo(() => {
    if (focusMs == null || !seams.length) return -1;
    let best = 0;
    let bestD = Infinity;
    seams.forEach((s, i) => {
      const d = Math.abs(s.srcBeforeMs - focusMs);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }, [seams, focusMs]);
  const seam = index >= 0 ? seams[index] : null;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !seam || !analysis) return;
    const parent = cv.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = LANE_H * 2 + 14;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const removed = Math.max(0, seam.srcAfterMs - seam.srcBeforeMs);
    const srcSpan = WINDOW_MS * 2 + removed;
    const pxPerMs = w / srcSpan;
    const css = getComputedStyle(document.documentElement);
    const fgVar = css.getPropertyValue("--c-fg").trim() || "248 248 242";
    const accentVar = css.getPropertyValue("--c-accent").trim() || "120 180 255";
    const fg = "rgb(" + fgVar + " / 0.55)";
    const accent = "rgb(" + accentVar + " / 0.85)";

    // 上排：來源（連續），被剪掉的區間打斜線
    const srcFrom = seam.srcBeforeMs - WINDOW_MS;
    drawLane(ctx, analysis, srcFrom, srcFrom + srcSpan, 0, w, 0, LANE_H, fg);
    if (removed > 0) {
      const rx = WINDOW_MS * pxPerMs;
      const rw = removed * pxPerMs;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, 0, rw, LANE_H);
      ctx.clip();
      ctx.strokeStyle = "rgb(248 113 113 / 0.45)";
      ctx.lineWidth = 1;
      for (let x = rx - LANE_H; x < rx + rw; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, LANE_H);
        ctx.lineTo(x + LANE_H, 0);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = "rgb(248 113 113 / 0.10)";
      ctx.fillRect(rx, 0, rw, LANE_H);
    }

    // 下排：剪完真正會聽到的接法（左尾直接接右頭），置中對齊接點
    const joinX = w / 2;
    const y2 = LANE_H + 14;
    const halfMs = Math.min(WINDOW_MS, joinX / pxPerMs);
    const halfPx = halfMs * pxPerMs;
    drawLane(ctx, analysis, seam.srcBeforeMs - halfMs, seam.srcBeforeMs, joinX - halfPx, halfPx, y2, LANE_H, fg);
    drawLane(ctx, analysis, seam.srcAfterMs, seam.srcAfterMs + halfMs, joinX, halfPx, y2, LANE_H, fg);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(joinX + 0.5, y2);
    ctx.lineTo(joinX + 0.5, y2 + LANE_H);
    ctx.stroke();
  }, [seam, analysis]);

  if (!seam) return null;

  const around = () => playRange(Math.max(0, seam.srcBeforeMs - WINDOW_MS), seam.srcAfterMs + WINDOW_MS, { skip: true, loop });
  const step = (i: number) => setFocusSeam(seams[Math.max(0, Math.min(seams.length - 1, index + i))]?.srcBeforeMs ?? null);
  const doTrim = (delta: number, mode: "ripple" | "roll", side: "left" | "right") => {
    trimSeam(seam.afterKeepId, delta, mode, side);
    // 修剪之後 keep 會重新編號，用新的位置繼續盯著同一刀
    setFocusSeam(seam.srcBeforeMs + (mode === "roll" || side === "left" ? delta : 0));
  };

  const removedMs = Math.max(0, seam.srcAfterMs - seam.srcBeforeMs);
  // 接縫附近的字：看得到這一刀是不是切在字中間
  const words = (transcript?.words ?? []).filter((w) => w.endMs > seam.srcBeforeMs - WINDOW_MS && w.startMs < seam.srcAfterMs + WINDOW_MS);

  return (
    <div className="shrink-0 border-b border-fg/10 bg-panel px-2 py-1.5">
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[11px] text-fg/50 mono tabular-nums whitespace-nowrap">
          {t("精準修剪")} {index + 1}/{seams.length}
        </span>
        <IconButton icon={ChevronLeft} label={t("上一個接縫")} onClick={() => step(-1)} disabled={index <= 0} />
        <IconButton icon={ChevronRight} label={t("下一個接縫")} onClick={() => step(1)} disabled={index >= seams.length - 1} />
        <span className="mono text-[11px] text-fg/60 tabular-nums whitespace-nowrap ml-1">
          {formatMs(seam.srcBeforeMs, { millis: true })}
          {removedMs > 0 && <span className="text-red-400/70"> −{Math.round(removedMs)} ms</span>}
          {seam.splitId && !seam.gapMs && <span className="text-accent/70"> · {t("切點")}</span>}
          {seam.gapMs > 0 && <span className="text-amber-400/80"> · {t("留白 {ms} ms", { ms: Math.round(seam.gapMs) })}</span>}
        </span>
        <IconButton icon={Play} label={t("巡這個接縫（前後各 1.2 秒）")} onClick={around} />
        <IconButton icon={Repeat} label={t("循環播放")} active={loop} onClick={() => setLoop((v) => !v)} />
        <button
          type="button"
          onClick={() => playRange(Math.max(0, seam.srcBeforeMs - WINDOW_MS), seam.srcBeforeMs, { skip: false })}
          className="h-7 px-1.5 rounded-sm text-[11px] text-fg/55 hover:bg-fg/5 whitespace-nowrap"
        >
          {t("只聽左尾")}
        </button>
        <button
          type="button"
          onClick={() => playRange(seam.srcAfterMs, seam.srcAfterMs + WINDOW_MS, { skip: false })}
          className="h-7 px-1.5 rounded-sm text-[11px] text-fg/55 hover:bg-fg/5 whitespace-nowrap"
        >
          {t("只聽右頭")}
        </button>
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setNudge(nudge === 10 ? 1 : 10)}
            title={t("每次微調多少毫秒（點一下切換 10 / 1）")}
            className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/55 hover:bg-fg/5 tabular-nums"
          >
            {nudge} ms
          </button>
          <span className="text-[10px] text-fg/35 px-1">{t("漣漪")}</span>
          <button
            type="button"
            onClick={() => doTrim(-nudge, "ripple", "left")}
            title={t("左邊界往前：多剪一點，後面整串跟著位移")}
            className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/60 hover:bg-fg/5"
          >
            ◄|
          </button>
          <button
            type="button"
            onClick={() => doTrim(nudge, "ripple", "left")}
            title={t("左邊界往後：少剪一點")}
            className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/60 hover:bg-fg/5"
          >
            |►
          </button>
          <button
            type="button"
            onClick={() => doTrim(-nudge, "ripple", "right")}
            title={t("右邊界往前：少剪一點")}
            className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/60 hover:bg-fg/5"
          >
            ◄|
          </button>
          <button
            type="button"
            onClick={() => doTrim(nudge, "ripple", "right")}
            title={t("右邊界往後：多剪一點")}
            className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/60 hover:bg-fg/5"
          >
            |►
          </button>
          <span className="text-[10px] text-fg/35 px-1">{t("捲動")}</span>
          <button
            type="button"
            onClick={() => doTrim(-nudge, "roll", "left")}
            title={t("接縫整段往前（成品總長不變）")}
            className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/60 hover:bg-fg/5"
          >
            ◄◄
          </button>
          <button
            type="button"
            onClick={() => doTrim(nudge, "roll", "left")}
            title={t("接縫整段往後（成品總長不變）")}
            className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/60 hover:bg-fg/5"
          >
            ►►
          </button>
          {seam.splitId && (
            <>
              <span className="text-[10px] text-fg/35 px-1">{t("留白")}</span>
              {PAUSE_STEPS.map((ms) => (
                <button
                  key={ms}
                  type="button"
                  onClick={() => setSeamPause(seam.afterKeepId, ms)}
                  title={ms === 0 ? t("不留白（直接對接）") : t("插入留白 {ms} ms", { ms })}
                  className={
                    "h-7 px-1.5 rounded-sm text-[11px] mono tabular-nums inline-flex items-center " +
                    (Math.round(seam.gapMs) === ms ? "bg-amber-400/15 text-amber-400" : "text-fg/55 hover:bg-fg/5")
                  }
                >
                  {ms === 0 ? <Scissors size={12} /> : ms}
                </button>
              ))}
              <IconButton icon={Trash} label={t("移除切點")} onClick={() => removeSeamSplit(seam.afterKeepId)} />
            </>
          )}
          <IconButton icon={X} label={t("關閉精準修剪")} onClick={() => setFocusSeam(null)} />
        </span>
      </div>
      <div className="relative mt-1">
        <canvas ref={canvasRef} className="block w-full" aria-hidden />
        {words.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden" style={{ height: LANE_H }}>
            {words.map((w) => {
              const srcFrom = seam.srcBeforeMs - WINDOW_MS;
              const left = ((w.startMs - srcFrom) / (WINDOW_MS * 2 + removedMs)) * 100;
              if (left < 0 || left > 100) return null;
              const cut = w.startMs >= seam.srcBeforeMs && w.endMs <= seam.srcAfterMs;
              return (
                <span
                  key={w.id}
                  className={"absolute top-0 text-[10px] whitespace-nowrap " + (cut ? "text-red-400/70 line-through" : "text-fg/45")}
                  style={{ left: left + "%" }}
                >
                  {w.text}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
