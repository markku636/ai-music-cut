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

/** 沒有開任何檔時的一般錄音：放在指定資料夾（或 home）的 `錄音_YYYYMMDD_HHMM.wav`。 */
export function freshRecordingPath(dir: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const s = sepOf(dir || "/");
  return `${dir.replace(/[\\/]+$/, "")}${s}錄音_${stamp}.wav`;
}
