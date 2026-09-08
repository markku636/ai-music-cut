// 錄音檔名：`<base>_take<N>.wav`，放在被重錄的那一集旁邊；N 從既有檔往上數。

function sepOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

export function takePath(basePath: string, n: number): string {
  const base = basePath.replace(/\.[^.]+$/, "");
  return `${base}_take${n}.wav`;
}

/** 從既有路徑（媒體清單）找出下一個 take 編號。 */
export function nextTakeIndex(basePath: string, existing: readonly string[]): number {
  const base = basePath.replace(/\.[^.]+$/, "").toLowerCase();
  let max = 0;
  for (const p of existing) {
    const m = p.toLowerCase().match(/^(.*)_take(\d+)\.wav$/);
    if (m && m[1] === base) max = Math.max(max, Number(m[2]));
  }
  return max + 1;
}

/** 一次查一批路徑存不存在（api.pathsExist 的形狀；測試注入假的）。 */
export type PathsExist = (paths: string[]) => Promise<boolean[]>;

/** 每次往磁碟問幾個候選（連號的 take 通常不會超過這麼多）。 */
const PROBE_BATCH = 8;
/** 最多往上找到第幾號；再多就不是正常使用，直接交回目前的候選。 */
const MAX_TAKE = 999;

/**
 * 跟 nextTakeIndex 一樣從媒體清單往上數，但**再去磁碟上確認**：
 * 新開的 session 媒體清單是空的，只看記憶體會把上次錄的 `_take1.wav` 蓋掉。
 * 記憶體的編號是下限（不回頭填洞，take 的順序才是時間順序），往上找第一個磁碟上也沒有的。
 * `exists` 失敗（後端沒有 paths_exist 指令）就退回只看記憶體，錄音不能因為查不到而不讓錄。
 */
export async function nextTakeIndexOnDisk(basePath: string, existing: readonly string[], exists: PathsExist): Promise<number> {
  let n = nextTakeIndex(basePath, existing);
  while (n <= MAX_TAKE) {
    const candidates = Array.from({ length: PROBE_BATCH }, (_, i) => takePath(basePath, n + i));
    let hits: boolean[];
    try {
      hits = await exists(candidates);
    } catch {
      return n;
    }
    const free = candidates.findIndex((_, i) => hits[i] !== true);
    if (free >= 0) return n + free;
    n += PROBE_BATCH;
  }
  return n;
}

/** 沒有開任何檔時的一般錄音：放在指定資料夾（或 home）的 `錄音_YYYYMMDD_HHMM.wav`。 */
export function freshRecordingPath(dir: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const s = sepOf(dir || "/");
  return `${dir.replace(/[\\/]+$/, "")}${s}錄音_${stamp}.wav`;
}
