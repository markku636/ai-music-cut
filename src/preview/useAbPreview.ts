import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { errMessage } from "../api";
import { toast } from "../ui";

export interface AbPair {
  dry: string;
  wet: string;
}

/**
 * A/B 試聽（同一段、兩個版本、來回按）。從 CleanupDialog 抽出來給所有效果對話框共用。
 *
 * 用法：`const ab = useAbPreview(() => renderPair())`；參數一改就 `ab.invalidate()`（手上那兩份過期了）；
 * 畫面上放 `<audio ref={ab.audioRef} onEnded={ab.onEnded} className="hidden" />`。
 */
export function useAbPreview(build: () => Promise<AbPair>) {
  const [pair, setPair] = useState<AbPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<"dry" | "wet" | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(null);
  }, []);

  const play = useCallback(
    (which: "dry" | "wet") => {
      if (!pair) return;
      if (playing === which) return stop();
      stop();
      const el = audioRef.current;
      if (!el) return;
      el.src = convertFileSrc(which === "dry" ? pair.dry : pair.wet);
      el.currentTime = 0;
      setPlaying(which);
      void el.play().catch(() => setPlaying(null));
    },
    [pair, playing, stop],
  );

  const run = useCallback(async () => {
    setBusy(true);
    stop();
    try {
      setPair(await buildRef.current());
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  }, [stop]);

  const invalidate = useCallback(() => {
    stop();
    setPair(null);
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { pair, busy, playing, audioRef, play, stop, run, invalidate, onEnded: () => setPlaying(null) };
}
