import { describe, expect, it } from "vitest";
import { bestVramMb, fitFor, formatMb, formatSpeed, recommendModel, HEADROOM } from "./asrFit";
import type { AsrHardware, AsrModelSpec } from "../api";

const spec = (name: string, vram: number, speed = 1): AsrModelSpec => ({
  name, download: "~1 GB", params_m: 100, vram_int8_mb: vram, ram_int8_mb: vram + 700, speed_x: speed,
});
// 真實的那四個（數字跟 Rust 的 MODELS 一致）
const SMALL = spec("small", 900, 6);
const MEDIUM = spec("medium", 1700, 2.5);
const TURBO = spec("large-v3-turbo", 1900, 4);
const LARGE = spec("large-v3", 3100, 1);
const ALL = [SMALL, MEDIUM, TURBO, LARGE];

const gpu = (vram: number, name = "NVIDIA GeForce RTX 4060"): AsrHardware => ({ nvidia: true, gpus: [{ name, vram_mb: vram }] });
const NO_GPU: AsrHardware = { nvidia: false, gpus: [] };

describe("bestVramMb", () => {
  it("沒有卡就是 null", () => {
    expect(bestVramMb(NO_GPU)).toBe(null);
    expect(bestVramMb(null)).toBe(null);
    expect(bestVramMb({ nvidia: true, gpus: [] })).toBe(null);
  });

  it("多張卡看最大的那一張（只會用一張，不會拆開跑）", () => {
    expect(bestVramMb({ nvidia: true, gpus: [{ name: "a", vram_mb: 8192 }, { name: "b", vram_mb: 24576 }] })).toBe(24576);
  });

  it("nvidia = false 時就算列出卡也不算（沒有驅動就用不到）", () => {
    expect(bestVramMb({ nvidia: false, gpus: [{ name: "a", vram_mb: 8192 }] })).toBe(null);
  });
});

describe("fitFor", () => {
  it("沒有 NVIDIA 卡 → 用 CPU 跑，不是「不夠」", () => {
    const r = fitFor(LARGE, NO_GPU);
    expect(r.fit).toBe("cpu");
    expect(r.vramMb).toBe(null);
    expect(r.shortByMb).toBe(0);
  });

  it("顯存充裕", () => {
    expect(fitFor(LARGE, gpu(16303)).fit).toBe("fits");
  });

  it("顯存剛好夠但沒有餘裕 → tight", () => {
    // 3100 需求，餘裕門檻是 3100 × 1.25 = 3875
    expect(fitFor(LARGE, gpu(3800)).fit).toBe("tight");
    expect(fitFor(LARGE, gpu(3100)).fit).toBe("tight");
  });

  it("剛好踩在餘裕門檻上算充裕", () => {
    expect(fitFor(LARGE, gpu(Math.ceil(3100 * HEADROOM))).fit).toBe("fits");
  });

  it("顯存不夠 → short，並算出還差多少", () => {
    const r = fitFor(LARGE, gpu(2048));
    expect(r.fit).toBe("short");
    expect(r.shortByMb).toBe(3100 - 2048);
  });

  it("同一張卡對不同模型會有不同結論", () => {
    const g = gpu(2048); // 2 GB
    expect(fitFor(SMALL, g).fit).toBe("fits");
    expect(fitFor(MEDIUM, g).fit).toBe("tight");
    expect(fitFor(TURBO, g).fit).toBe("tight");
    expect(fitFor(LARGE, g).fit).toBe("short");
  });
});

describe("recommendModel", () => {
  it("跑得動的裡面挑最準的（清單由小到大）", () => {
    expect(recommendModel(ALL, gpu(16303))?.name).toBe("large-v3");
    // 4 GB 已經過得了 large-v3 的餘裕門檻（3100 × 1.25 = 3875）
    expect(recommendModel(ALL, gpu(4096))?.name).toBe("large-v3");
    // 3 GB 過不了 large-v3，但過得了 turbo（1900 × 1.25 = 2375）
    expect(recommendModel(ALL, gpu(3000))?.name).toBe("large-v3-turbo");
    // 2200 過得了 medium（1700 × 1.25 = 2125）但過不了 turbo（2375）
    expect(recommendModel(ALL, gpu(2200))?.name).toBe("medium");
  });

  it("一張都跑不動就回最小的（讓 UI 去說它會用 CPU）", () => {
    expect(recommendModel(ALL, gpu(512))?.name).toBe("small");
  });

  it("沒有卡就回最小的", () => {
    expect(recommendModel(ALL, NO_GPU)?.name).toBe("small");
  });

  it("空清單回 null，不會爆", () => {
    expect(recommendModel([], gpu(8192))).toBe(null);
  });
});

describe("顯示格式", () => {
  it("不到 1 GB 用 MB（不然會出現不好讀的 0.9 GB）", () => {
    expect(formatMb(900)).toBe("900 MB");
    expect(formatMb(1024)).toBe("1.0 GB");
    expect(formatMb(3100)).toBe("3.0 GB");
  });

  it("壞值不顯示數字", () => {
    expect(formatMb(0)).toBe("—");
    expect(formatMb(NaN)).toBe("—");
    expect(formatMb(-5)).toBe("—");
  });

  it("速度以 large-v3 為基準", () => {
    expect(formatSpeed(1)).toBe("基準");
    expect(formatSpeed(2.5)).toBe("≈ 2.5× 快");
    expect(formatSpeed(6)).toBe("≈ 6× 快");
    expect(formatSpeed(0)).toBe("—");
  });
});
