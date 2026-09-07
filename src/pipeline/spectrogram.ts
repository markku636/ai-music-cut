// 頻譜圖：畫面看哪一段就跟 Rust 要哪一段的 PNG（showspectrumpic），這裡負責去重與快取。
//
// 為什麼不預算整檔：固定 hop 的 spectrogram.bin 撐不了「縮到 2 秒」的視窗（會糊成一片），
// 一小時還要 +16 MB。on-demand 一張 800×120 的圖 100–300 ms 就回來，捲動時前一張先留著位移。
import { api } from "../api";

export type SpectrogramPalette = "magma" | "viridis" | "plasma" | "cividis" | "fire" | "intensity";

/** 一次最多看多長（超過就不畫：Rust 端也擋）。 */
export const MAX_SPECTROGRAM_MS = 600_000;

interface MediaRef {
  path: string;
  fingerprint: string;
  id: string;
}

const CACHE_MAX = 48;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function keyOf(m: MediaRef, startMs: number, endMs: number, w: number, h: number, palette: string): string {
  return `${m.fingerprint || m.id}|${Math.round(startMs)}|${Math.round(endMs)}|${w}x${h}|${palette}`;
}

/** 把視窗量化到 1/8 視窗寬的格子：小幅捲動時命中同一張，不會每個 pixel 都重算。 */
export function quantizeWindow(startMs: number, endMs: number, durationMs: number): { startMs: number; endMs: number } {
  const len = Math.max(50, endMs - startMs);
  const grid = Math.max(10, len / 8);
  const s = Math.max(0, Math.floor(startMs / grid) * grid);
  const e = Math.min(Math.max(durationMs, s + 50), Math.ceil(endMs / grid) * grid);
  return { startMs: s, endMs: e };
}

export function requestSpectrogram(m: MediaRef, startMs: number, endMs: number, w: number, h: number, palette: SpectrogramPalette): Promise<string> {
  const key = keyOf(m, startMs, endMs, w, h, palette);
  const hit = cache.get(key);
  if (hit) {
    // LRU：碰到就移到最後
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = api
    .mediaSpectrogram(m.path, m.fingerprint || m.id, startMs, endMs, w, h, palette)
    .then((path) => {
      cache.set(key, path);
      while (cache.size > CACHE_MAX) {
        const first = cache.keys().next().value;
        if (first === undefined) break;
        cache.delete(first);
      }
      return path;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 測試 / 換媒體時清掉。 */
export function clearSpectrogramCache(): void {
  cache.clear();
}
