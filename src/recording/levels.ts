// 錄音電平：逐包峰值、1.5 秒 peak hold、削波判定。LoudnessMeter 讀的是分析檔不是即時流，這裡另寫一份。

export const CLIP_DBFS = -0.1;
export const HOLD_MS = 1500;

export function peakDb(chunk: Float32Array): number {
  let p = 0;
  for (let i = 0; i < chunk.length; i++) {
    const a = Math.abs(chunk[i]);
    if (a > p) p = a;
  }
  return p <= 1e-6 ? -120 : 20 * Math.log10(p);
}

export function rmsDb(chunk: Float32Array): number {
  if (!chunk.length) return -120;
  let s = 0;
  for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i];
  const r = Math.sqrt(s / chunk.length);
  return r <= 1e-6 ? -120 : 20 * Math.log10(r);
}

export function isClipping(db: number): boolean {
  return db >= CLIP_DBFS;
}

export interface LevelState {
  peakDb: number;
  holdDb: number;
  holdUntil: number;
  clipped: boolean;
}

export function initialLevel(): LevelState {
  return { peakDb: -120, holdDb: -120, holdUntil: 0, clipped: false };
}

/** 餵一包，回新狀態（純函式）。 */
export function pushLevel(s: LevelState, db: number, now: number): LevelState {
  const hold = db >= s.holdDb || now >= s.holdUntil ? { holdDb: db, holdUntil: now + HOLD_MS } : { holdDb: s.holdDb, holdUntil: s.holdUntil };
  return { peakDb: db, holdDb: hold.holdDb, holdUntil: hold.holdUntil, clipped: s.clipped || isClipping(db) };
}

/** 電平（dBFS）→ 0–1 的表寬（−60 → 0）。 */
export function meterFraction(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
