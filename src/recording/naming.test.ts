import { describe, expect, it } from "vitest";
import { freshRecordingPath, nextTakeIndex, nextTakeIndexOnDisk, takePath } from "./naming";

/** 假磁碟：小寫比（Windows 大小寫不分），並記下問過哪些路徑。 */
function disk(...files: string[]) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const asked: string[] = [];
  const exists = async (paths: string[]) => {
    asked.push(...paths);
    return paths.map((p) => set.has(p.toLowerCase()));
  };
  return { exists, asked };
}

describe("takePath / nextTakeIndex", () => {
  it("<base>_take<N>.wav；從媒體清單往上數（大小寫不分、別的檔不算）", () => {
    expect(takePath("C:\\a\\ep1.mp3", 2)).toBe("C:\\a\\ep1_take2.wav");
    expect(nextTakeIndex("C:\\a\\ep1.mp3", [])).toBe(1);
    expect(nextTakeIndex("C:\\a\\ep1.mp3", ["C:\\a\\EP1_take3.wav", "C:\\a\\ep2_take9.wav"])).toBe(4);
  });
});

describe("nextTakeIndexOnDisk", () => {
  const base = "C:\\a\\ep1.mp3";

  it("磁碟上沒有就跟只看記憶體一樣", async () => {
    await expect(nextTakeIndexOnDisk(base, [], disk().exists)).resolves.toBe(1);
  });

  it("新 session 媒體清單是空的：磁碟上已有 take1、take2 就給 3，不會蓋掉", async () => {
    const d = disk("C:\\a\\ep1_take1.wav", "C:\\a\\EP1_take2.wav");
    await expect(nextTakeIndexOnDisk(base, [], d.exists)).resolves.toBe(3);
  });

  it("記憶體的編號是下限：清單有 take5、磁碟只有 take1 → 6（不回頭填洞）", async () => {
    const d = disk("C:\\a\\ep1_take1.wav");
    await expect(nextTakeIndexOnDisk(base, ["C:\\a\\ep1_take5.wav"], d.exists)).resolves.toBe(6);
    expect(d.asked).not.toContain("C:\\a\\ep1_take1.wav");
  });

  it("連號很多也找得到（跨批次往上問）", async () => {
    const d = disk(...Array.from({ length: 20 }, (_, i) => `C:\\a\\ep1_take${i + 1}.wav`));
    await expect(nextTakeIndexOnDisk(base, [], d.exists)).resolves.toBe(21);
  });

  it("exists 失敗（後端沒有 paths_exist）就退回只看記憶體", async () => {
    const boom = async () => {
      throw new Error("no cmd");
    };
    await expect(nextTakeIndexOnDisk(base, ["C:\\a\\ep1_take2.wav"], boom)).resolves.toBe(3);
  });
});

describe("freshRecordingPath", () => {
  it("錄音_YYYYMMDD_HHMM.wav 放在指定資料夾（結尾斜線可有可無）", () => {
    const at = new Date(2026, 8, 7, 9, 5);
    expect(freshRecordingPath("C:\\rec\\", at)).toBe("C:\\rec\\錄音_20260907_0905.wav");
    expect(freshRecordingPath("/home/u", at)).toBe("/home/u/錄音_20260907_0905.wav");
  });
});
