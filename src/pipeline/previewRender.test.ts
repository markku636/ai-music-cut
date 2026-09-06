import { describe, expect, it } from "vitest";
import type { RenderPlan } from "../api";
import { previewKey, previewPath } from "./previewRender";

function plan(over: Partial<RenderPlan> = {}): RenderPlan {
  return {
    segs: [
      { src_start_ms: 0, src_end_ms: 1000, gain_db: 0 },
      { src_start_ms: 1500, src_end_ms: 3000, gain_db: 0 },
    ],
    effects: [],
    joins: [{ kind: "crossfade", ms: 20 }],
    crossfade_ms: 20,
    target_lufs: -16,
    true_peak_dbtp: -1.5,
    format: "mp3",
    out_path: "C:/out/a.mp3",
    channels: 1,
    ...over,
  };
}

describe("previewKey", () => {
  it("同樣的內容 → 同一把鍵（快取才命中得了）", () => {
    expect(previewKey(plan())).toBe(previewKey(plan()));
  });

  it("輸出路徑 / 格式 / 響度目標不影響鍵（那些不改變聽起來如何）", () => {
    expect(previewKey(plan({ out_path: "D:/別的地方.wav", format: "wav", target_lufs: -23 }))).toBe(previewKey(plan()));
  });

  it("剪點一動就換鍵", () => {
    expect(previewKey(plan({ segs: [{ src_start_ms: 0, src_end_ms: 1001, gain_db: 0 }] }))).not.toBe(previewKey(plan()));
  });

  it("接點種類 / 長度一動就換鍵", () => {
    expect(previewKey(plan({ joins: [{ kind: "gap", ms: 150 }] }))).not.toBe(previewKey(plan()));
    expect(previewKey(plan({ joins: [{ kind: "crossfade", ms: 24 }] }))).not.toBe(previewKey(plan()));
  });

  it("修聲一動就換鍵 —— 不然調完降噪按預覽會拿到上一份快取檔", () => {
    const clean = { rumble_hz: 80, denoise_db: 12, noise_floor_db: -48, deess_amount: 0 };
    expect(previewKey(plan({ cleanup: clean }))).not.toBe(previewKey(plan()));
    expect(previewKey(plan({ cleanup: { ...clean, denoise_db: 13 } }))).not.toBe(previewKey(plan({ cleanup: clean })));
    expect(previewKey(plan({ cleanup: { ...clean, deess_amount: 0.3 } }))).not.toBe(previewKey(plan({ cleanup: clean })));
    // 同一組設定要命中同一把鍵
    expect(previewKey(plan({ cleanup: { ...clean } }))).toBe(previewKey(plan({ cleanup: clean })));
  });

  it("效果一動就換鍵", () => {
    expect(previewKey(plan({ effects: [{ kind: "mute", start_ms: 100, end_ms: 200, db: 0 }] }))).not.toBe(previewKey(plan()));
  });

  it("增益一動就換鍵（逐段平衡會改這個）", () => {
    const p = plan();
    p.segs[1].gain_db = -1.5;
    expect(previewKey(p)).not.toBe(previewKey(plan()));
  });

  it("是 8 位十六進位", () => {
    expect(previewKey(plan())).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("previewPath", () => {
  it("Windows 路徑用反斜線、POSIX 用斜線", () => {
    expect(previewPath("C:\\cache", "abcdef0123456789ff", "1a2b3c4d")).toBe("C:\\cache\\preview\\abcdef0123456789\\preview-1a2b3c4d.mp3");
    expect(previewPath("/tmp/cache", "abcdef0123456789ff", "1a2b3c4d")).toBe("/tmp/cache/preview/abcdef0123456789/preview-1a2b3c4d.mp3");
  });

  it("沒有指紋時不會產生怪路徑", () => {
    expect(previewPath("/c", "", "k")).toBe("/c/preview/unknown/preview-k.mp3");
  });
});
