import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type WaveSurfer from "wavesurfer.js";
import { MAX_SPECTROGRAM_MS, quantizeWindow, requestSpectrogram, type SpectrogramPalette } from "../pipeline/spectrogram";
import { useT } from "../i18n";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTheme } from "../theme";

/**
 * 頻譜圖疊層：放在 wavesurfer **底下**（DOM 上排在它前面），只畫可視範圍。
 * 捲動 / 縮放時先把手上那張依新的 px/秒 位移縮放（不會閃白），150 ms 沒再動才向 Rust 要新的一張。
 * 視窗超過 10 分鐘不畫（縮小到那種程度頻譜也看不出東西）。
 */
export default function SpectrogramLayer({ ws, mediaId, top, height }: { ws: WaveSurfer | null; mediaId: string | null; top: number; height: number }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const mode = useTimeline((s) => s.viewMode);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fit = useTimeline((s) => s.fitPxPerSec);
  const theme = useTheme((s) => s.theme);
  const media = useProject((s) => (mediaId ? s.media.find((m) => m.id === mediaId) : undefined));
  const [img, setImg] = useState<{ src: string; startMs: number; endMs: number } | null>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const [tooWide, setTooWide] = useState(false);
  const seq = useRef(0);
  const palette: SpectrogramPalette = theme === "light" ? "viridis" : "magma";

  useEffect(() => {
    setImg(null);
  }, [mediaId, palette]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ws || !media || mode === "wave") return;
    let timer = 0;
    let raf = 0;
    const px = () => pxPerSec ?? fit;
    const durationMs = media.probe?.duration_ms ?? 0;

    const layout = () => {
      raf = 0;
      setImg((cur) => {
        if (!cur) return cur;
        const scroll = ws.getScroll();
        setBox({ left: (cur.startMs / 1000) * px() - scroll, width: ((cur.endMs - cur.startMs) / 1000) * px() });
        return cur;
      });
    };
    const request = () => {
      const w = host.clientWidth;
      if (w < 16 || height < 16) return;
      const scroll = ws.getScroll();
      const startMs = (scroll / px()) * 1000;
      const endMs = Math.min(durationMs || Infinity, ((scroll + w) / px()) * 1000);
      if (endMs - startMs > MAX_SPECTROGRAM_MS) {
        setTooWide(true);
        return;
      }
      setTooWide(false);
      const win = quantizeWindow(startMs, endMs, durationMs);
      const wPx = Math.round(((win.endMs - win.startMs) / 1000) * px());
      const mine = ++seq.current;
      requestSpectrogram(media, win.startMs, win.endMs, Math.max(16, wPx), Math.max(16, Math.round(height)), palette)
        .then((path) => {
          if (mine !== seq.current) return;
          setImg({ src: convertFileSrc(path), startMs: win.startMs, endMs: win.endMs });
          setBox({ left: (win.startMs / 1000) * px() - ws.getScroll(), width: wPx });
        })
        .catch(() => {
          /* 頻譜圖失敗不影響剪輯；留著上一張 */
        });
    };
    const onMove = () => {
      if (!raf) raf = requestAnimationFrame(layout);
      clearTimeout(timer);
      timer = window.setTimeout(request, 150);
    };
    request();
    const offs = [ws.on("scroll", onMove), ws.on("zoom", onMove), ws.on("redraw", onMove)];
    const ro = new ResizeObserver(onMove);
    ro.observe(host);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      offs.forEach((f) => f());
      ro.disconnect();
    };
  }, [ws, media, mode, pxPerSec, fit, height, palette]);

  if (mode === "wave") return null;
  return (
    <div ref={hostRef} className="absolute left-0 right-0 overflow-hidden pointer-events-none" style={{ top, height }} data-testid="spectrogram-layer" data-mode={mode}>
      {img && box && (
        <img
          src={img.src}
          alt=""
          draggable={false}
          data-testid="spectrogram-img"
          className={mode === "both" ? "opacity-70" : ""}
          style={{ position: "absolute", top: 0, left: box.left, width: box.width, height, maxWidth: "none" }}
        />
      )}
      {tooWide && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-fg/40">{t("頻譜：放大到 10 分鐘以內才會畫")}</div>}
    </div>
  );
}
