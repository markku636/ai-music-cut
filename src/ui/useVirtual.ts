// windowFor 的 React 外殼：量視窗、量列高、跟著捲動更新。
//
// 列高用 key（不是索引）記，篩選讓清單重排時量過的高度才不會錯位。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { averageHeight, windowFor } from "./virtual";

export interface Virtual {
  /** 掛在捲動容器上。 */
  scrollRef: React.RefObject<HTMLDivElement>;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  /** 掛在每一列上（ref callback），用來量高度。 */
  measure: (key: string) => (el: HTMLElement | null) => void;
  /**
   * 把某一列捲進視野（那一列可能根本不在 DOM 裡，所以不能用 scrollIntoView）。
   *
   * block="nearest"（預設）已經看得到就不動 —— 鍵盤連按時清單才不會一直跳。
   * block="center" 一律置中，跟著播放線讀逐字稿時要的是這個。
   */
  scrollToKey: (key: string, opts?: { block?: "nearest" | "center" }) => void;
}

export function useVirtual(keys: string[], estimate: number, overscan = 6): Virtual {
  const scrollRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [, bump] = useState(0);
  const [view, setView] = useState({ top: 0, height: 0 });

  // 量到的高度變了要重算視窗，但**不是每量一列就重繪一次** ——
  // 一次捲動會量到十幾列，逐列 setState 會打成十幾次繪製。統一併到下一格。
  const pendingBump = useRef(false);
  const scheduleBump = useCallback(() => {
    if (pendingBump.current) return;
    pendingBump.current = true;
    requestAnimationFrame(() => {
      pendingBump.current = false;
      bump((n) => n + 1);
    });
  }, []);

  const measure = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (!el) return;
      const h = el.offsetHeight;
      if (h <= 0) return;
      const prev = heights.current.get(key);
      if (prev != null && Math.abs(prev - h) < 0.5) return;
      heights.current.set(key, h);
      scheduleBump();
    },
    [scheduleBump],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    sync();
    // 捲動事件每格只處理一次就夠了
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        sync();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  const heightList = useMemo(() => keys.map((k) => heights.current.get(k)), [keys, view, estimate]); // eslint-disable-line react-hooks/exhaustive-deps
  const est = averageHeight(heightList, estimate);
  const win = windowFor({ count: keys.length, heights: heightList, estimate: est, scrollTop: view.top, viewportHeight: view.height, overscan });

  const scrollToKey = useCallback(
    (key: string, opts?: { block?: "nearest" | "center" }) => {
      const el = scrollRef.current;
      if (!el) return;
      const idx = keys.indexOf(key);
      if (idx < 0) return;
      const h = (i: number) => heights.current.get(keys[i]) ?? est;
      let top = 0;
      for (let i = 0; i < idx; i++) top += h(i);
      const height = h(idx);
      if (opts?.block === "center") {
        el.scrollTop = Math.max(0, top - (el.clientHeight - height) / 2);
        return;
      }
      // 已經看得到就不要動（鍵盤連按時清單一直跳很難用）
      if (top >= el.scrollTop && top + height <= el.scrollTop + el.clientHeight) return;
      el.scrollTop = top < el.scrollTop ? top : top + height - el.clientHeight;
    },
    [keys, est],
  );

  // keys 變短（篩選）之後捲動位置可能懸空，拉回範圍內
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop > max) el.scrollTop = max;
  }, [keys.length]);

  return { scrollRef, start: win.start, end: win.end, padTop: win.padTop, padBottom: win.padBottom, measure, scrollToKey };
}
