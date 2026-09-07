// 選取的平均功率譜（Rust spectrum.rs 算的 dB / bin）上做的判斷：嗡聲偵測。
//
// 電源嗡聲 = 50 或 60 Hz 的基頻 + 諧波。判法：在 ±1.5 Hz 內找峰、峰要比「附近的中位數」高一截，
// 而且至少要有基頻以外的兩個諧波也高出來 —— 單一個 60 Hz 的峰可能只是低頻的聲音，
// 諧波排成一列才是電源。

export interface SpectrumData {
  sample_rate: number;
  n: number;
  db: ArrayLike<number>;
  frames: number;
}

export interface HumReport {
  baseHz: 50 | 60 | null;
  /** 基頻峰高出附近中位數幾 dB。 */
  prominenceDb: number;
  /** 每個諧波（含基頻）的峰值 dBFS；沒偵測到的是 null。 */
  harmonicsDb: (number | null)[];
  /** 偵測到幾個諧波（含基頻）。 */
  harmonics: number;
  summary: string;
}

/** 峰要高出局部中位數這麼多才算。 */
export const HUM_PROMINENCE_DB = 12;
/** 至少要有這麼多個（含基頻）才叫嗡聲。 */
export const HUM_MIN_HARMONICS = 3;
const MAX_HARMONICS = 8;

function binOf(hz: number, sp: SpectrumData): number {
  return Math.round((hz * sp.n) / sp.sample_rate);
}

function median(xs: number[]): number {
  if (!xs.length) return -120;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** hz ± tolHz 內的最高 bin（dB），與 ±20 bin 範圍（扣掉峰附近）的中位數。 */
function peakAt(sp: SpectrumData, hz: number, tolHz: number): { peak: number; local: number } | null {
  const c = binOf(hz, sp);
  const tol = Math.max(1, Math.round((tolHz * sp.n) / sp.sample_rate));
  if (c - tol < 1 || c + tol >= sp.db.length) return null;
  let peak = -Infinity;
  for (let b = c - tol; b <= c + tol; b++) peak = Math.max(peak, sp.db[b]);
  const around: number[] = [];
  for (let b = Math.max(1, c - 20); b < Math.min(sp.db.length, c + 21); b++) if (Math.abs(b - c) > tol + 1) around.push(sp.db[b]);
  return { peak, local: median(around) };
}

function scan(sp: SpectrumData, base: 50 | 60): { prominence: number; harmonicsDb: (number | null)[]; count: number } {
  const harmonicsDb: (number | null)[] = [];
  let count = 0;
  let prominence = -Infinity;
  for (let k = 1; k <= MAX_HARMONICS; k++) {
    const p = peakAt(sp, base * k, 1.5 + 0.5 * k);
    if (!p) {
      harmonicsDb.push(null);
      continue;
    }
    const prom = p.peak - p.local;
    if (k === 1) prominence = prom;
    if (prom >= HUM_PROMINENCE_DB) {
      harmonicsDb.push(Math.round(p.peak * 10) / 10);
      count++;
    } else harmonicsDb.push(null);
  }
  return { prominence, harmonicsDb, count };
}

/** 從平均功率譜判斷有沒有電源嗡聲、是 50 還是 60。 */
export function findHum(sp: SpectrumData): HumReport {
  // bin 要細到分得開 50 與 60（差 10 Hz）：> 6 Hz / bin 就不判
  if (!sp || !sp.db || sp.db.length < 64 || sp.sample_rate / sp.n > 6) {
    return { baseHz: null, prominenceDb: 0, harmonicsDb: [], harmonics: 0, summary: "頻譜解析度不夠，判不出嗡聲" };
  }
  const r50 = scan(sp, 50);
  const r60 = scan(sp, 60);
  const pick = (a: typeof r50, b: typeof r60) => (a.count > b.count ? 50 : b.count > a.count ? 60 : a.prominence >= b.prominence ? 50 : 60);
  const base = pick(r50, r60) as 50 | 60;
  const r = base === 50 ? r50 : r60;
  if (r.count < HUM_MIN_HARMONICS || r.harmonicsDb[0] == null) {
    return { baseHz: null, prominenceDb: Math.max(0, Math.round(Math.max(r50.prominence, r60.prominence))), harmonicsDb: r.harmonicsDb, harmonics: r.count, summary: "沒有偵測到明顯的電源嗡聲（50 / 60 Hz 與諧波都不突出）" };
  }
  return {
    baseHz: base,
    prominenceDb: Math.round(r.prominence),
    harmonicsDb: r.harmonicsDb,
    harmonics: r.count,
    summary: `量到 ${base} Hz 嗡聲（基頻 ${r.harmonicsDb[0]} dBFS，比附近高 ${Math.round(r.prominence)} dB），共 ${r.count} 個諧波突出`,
  };
}

/** 諧波數的建議：偵測到幾個就挖幾個（至少 2、最多 8）。 */
export function suggestedHarmonics(r: HumReport): number {
  if (!r.baseHz) return 4;
  let last = 0;
  r.harmonicsDb.forEach((v, i) => {
    if (v != null) last = i + 1;
  });
  return Math.max(2, Math.min(MAX_HARMONICS, last));
}
