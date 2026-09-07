import { useEffect, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import { SNAP_KIND_LABEL } from "../analysis/snap";
import { useT } from "../i18n";
import { useTimeline } from "../store/timeline";

/** 吸附指示停留多久。太短看不到，太長會一直卡在畫面上像壞掉。 */
const HOLD_MS = 900;

/**
 * 吸附指示：吸到哪裡、吸到什麼。
 *
 * 吸附一直都有在動（`store/timeline.snapMs` 會把結果記進 `lastSnapHit`），但**沒有
 * 任何地方讀它** —— 也就是說拖一刀的時候位置會自己跳個幾十毫秒，畫面上完全沒有交代。
 * 使用者只會覺得「我明明放在這裡」。每一套剪輯軟體吸附時都會給指示，理由就是這個。
 *
 * 標出**吸到什麼**而不只是畫一條線：吸到「句界」跟吸到「拍點」是兩種完全不同的意圖，
 * 而且吸錯的時候要看得出來是哪一類在作怪（才知道要關掉哪一個吸附來源）。
 */
export default function SnapIndicator({ ws, height }: { ws: WaveSurfer | null; height: number }) {
  const t = useT();
  const hit = useTimeline((s) => s.lastSnapHit);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fit = useTimeline((s) => s.fitPxPerSec);
  const [scroll, setScroll] = useState(0);
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // 每次吸到新位置就重新計時：連續拖曳時指示要跟著走，不要閃一下就沒了
  useEffect(() => {
    if (!hit) {
      setVisible(false);
      return;
    }
    setVisible(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), HOLD_MS);
    return () => window.clearTimeout(timer.current);
  }, [hit]);

  useEffect(() => {
    if (!ws) return;
    const sync = () => setScroll(ws.getScroll());
    sync();
    const offs = [ws.on("scroll", sync), ws.on("zoom", sync), ws.on("redraw", sync)];
    return () => offs.forEach((f) => f());
  }, [ws]);

  if (!hit || !visible || !ws) return null;
  const px = pxPerSec ?? fit;
  const x = (hit.ms / 1000) * px - scroll;
  // 捲出畫面就不要畫（不然標籤會黏在邊緣看起來像位置錯了）
  if (x < 0 || x > (ws.getWrapper()?.clientWidth ?? 0)) return null;

  return (
    <div className="pointer-events-none absolute top-0 z-20" style={{ left: x, height }}>
      <div className="h-full w-px bg-accent/70" />
      <div className="mono absolute left-1 top-0 whitespace-nowrap rounded-sm bg-accent/85 px-1 text-[10px] leading-4 text-white">
        {t(SNAP_KIND_LABEL[hit.kind])}
      </div>
    </div>
  );
}
