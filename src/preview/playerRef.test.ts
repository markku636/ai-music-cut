import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRangePlaying, lastRangeStop, playRange, setPlayer, stopRange } from "./playerRef";
import { bindGainTarget, currentGain, __resetGains } from "./previewGain";
import { __setScheduler } from "./ticker";

/** 夠用的假 <audio>：只有 playRange 會碰到的欄位。 */
function fakeAudio() {
  const listeners = new Map<string, Set<() => void>>();
  const el = {
    src: "asset://fake.m4a",
    currentTime: 0,
    paused: true,
    volume: 1,
    playbackRate: 1,
    // 瀏覽器的媒體事件是排進 task queue 的，不是同步派發 —— 這個時序差正是被修掉的那個 bug。
    play: vi.fn(
      () =>
        new Promise<void>((res) => {
          el.paused = false;
          setTimeout(() => {
            el.emit("playing");
            res();
          }, 0);
        }),
    ),
    pause: vi.fn(() => {
      el.paused = true;
      setTimeout(() => el.emit("pause"), 0);
    }),
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    /** 手動派發（模擬瀏覽器非同步送出的事件）。 */
    emit(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return el;
}

/** 手動推進的假 rAF。 */
function fakeTicker() {
  const q = new Map<number, () => void>();
  let next = 1;
  __setScheduler(
    (cb) => {
      const h = next++;
      q.set(h, cb);
      return h;
    },
    (h) => {
      q.delete(h);
    },
  );
  return () => {
    const now = [...q.values()];
    q.clear();
    for (const cb of now) cb();
  };
}

describe("playRange", () => {
  let el: ReturnType<typeof fakeAudio>;
  let frame: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetGains();
    el = fakeAudio();
    setPlayer(el as unknown as HTMLAudioElement);
    bindGainTarget(el as unknown as HTMLAudioElement);
    frame = fakeTicker();
  });

  afterEach(() => {
    stopRange();
    setPlayer(null);
    bindGainTarget(null);
    vi.useRealTimers();
  });

  it("從 startMs 開始播並記錄預聽範圍", () => {
    playRange(2000, 4000, { skip: false });
    expect(el.currentTime).toBeCloseTo(2, 6);
    expect(el.play).toHaveBeenCalled();
    expect(isRangePlaying()).toBe(true);
  });

  it("呼叫前剛好 pause 過的那顆事件不能把這次播放殺掉", async () => {
    // 呼叫端先 pause()，那顆事件會晚一步打中我們剛掛上的監聽器，把這次播放當場殺掉。
    el.pause();
    playRange(2000, 4000, { skip: false });
    await vi.runAllTimersAsync(); // 遲到的 pause 先到，接著才是 playing
    expect(isRangePlaying()).toBe(true);
    expect(lastRangeStop()?.reason).not.toBe("pause-event");
  });

  it("真的被使用者按暫停才收工", async () => {
    playRange(2000, 4000, { skip: false });
    await vi.runAllTimersAsync(); // 讓 play() 的 promise 完成 → started = true
    el.pause();
    await vi.runAllTimersAsync();
    expect(isRangePlaying()).toBe(false);
    expect(lastRangeStop()?.reason).toBe("pause-event");
  });

  it("播到尾端自然結束：呼叫 onEnd、放掉音量、退訂 ticker", async () => {
    const onEnd = vi.fn();
    playRange(2000, 4000, { skip: false, onEnd });
    await vi.runAllTimersAsync();
    el.currentTime = 4.0;
    frame();
    await vi.runAllTimersAsync();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(isRangePlaying()).toBe(false);
    expect(el.paused).toBe(true);
    expect(currentGain()).toBe(1);
    expect(lastRangeStop()?.reason).toBe("natural");
  });

  it("手動停止不算自然結束（不呼叫 onEnd）", async () => {
    const onEnd = vi.fn();
    const stop = playRange(2000, 4000, { skip: false, onEnd });
    await vi.runAllTimersAsync();
    stop();
    expect(onEnd).not.toHaveBeenCalled();
    expect(lastRangeStop()?.reason).toBe("manual");
  });

  it("loop 到尾端回到開頭而不是停止", async () => {
    playRange(2000, 4000, { skip: false, loop: true });
    await vi.runAllTimersAsync();
    el.currentTime = 4.2;
    frame();
    expect(el.currentTime).toBeCloseTo(2, 6);
    expect(isRangePlaying()).toBe(true);
  });

  it("使用者跳離這段就結束範圍模式", async () => {
    playRange(5000, 9000, { skip: false });
    await vi.runAllTimersAsync();
    el.currentTime = 1.0;
    frame();
    expect(isRangePlaying()).toBe(false);
    expect(lastRangeStop()?.reason).toBe("left-range");
  });

  it("尾端進入音量斜坡，結束後把 range 增益還原", async () => {
    playRange(2000, 4000, { skip: false });
    await vi.runAllTimersAsync();
    el.currentTime = 3.985; // 距離尾端 15 ms，在 30 ms 斜坡內
    frame();
    expect(currentGain()).toBeLessThan(1);
    expect(currentGain()).toBeGreaterThan(0);
    await vi.runAllTimersAsync(); // 精準收尾的 setTimeout 到期
    expect(isRangePlaying()).toBe(false);
    expect(currentGain()).toBe(1);
  });

  it("連續兩次 playRange：前一次要乾淨收掉，不留監聽器", async () => {
    playRange(1000, 2000, { skip: false });
    await vi.runAllTimersAsync();
    playRange(5000, 6000, { skip: false });
    await vi.runAllTimersAsync();
    expect(el.listenerCount("pause")).toBe(1);
    expect(el.listenerCount("playing")).toBe(1);
    expect(isRangePlaying()).toBe(true);
  });

  it("沒有播放器時安靜地不做事", () => {
    setPlayer(null);
    expect(() => playRange(0, 1000, { skip: false })()).not.toThrow();
    expect(isRangePlaying()).toBe(false);
  });
});
