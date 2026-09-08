import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERT } from "../analysis/convertPlan";
import { planOutPaths, planOutPathsOnDisk, type ConvertBatchOptions } from "./convert";

const opts: ConvertBatchOptions = { ...DEFAULT_CONVERT, format: "mp3", outDir: null };

/** 假磁碟：小寫比（Windows 大小寫不分），並記下每一輪問了什麼。 */
function disk(...files: string[]) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const calls: string[][] = [];
  const exists = async (paths: string[]) => {
    calls.push(paths);
    return paths.map((p) => set.has(p.toLowerCase()));
  };
  return { exists, calls };
}

describe("planOutPathsOnDisk", () => {
  it("磁碟上沒有撞名就跟 planOutPaths 一樣，只查一次", async () => {
    const d = disk();
    const srcs = ["C:\\a\\ep1.wav", "C:\\a\\ep2.wav"];
    await expect(planOutPathsOnDisk(srcs, opts, d.exists)).resolves.toEqual(planOutPaths(srcs, opts));
    expect(d.calls).toHaveLength(1);
  });

  it("輸出路徑已經有檔（mp3 旁邊的無損母帶）就往後排 _2、_3…；排到的新名字也要再查", async () => {
    const d = disk("C:\\a\\EP1.mp3", "C:\\a\\ep1_2.mp3");
    await expect(planOutPathsOnDisk(["C:\\a\\ep1.wav"], opts, d.exists)).resolves.toEqual(["C:\\a\\ep1_3.mp3"]);
    expect(d.calls).toEqual([["C:\\a\\ep1.mp3"], ["C:\\a\\ep1_2.mp3"], ["C:\\a\\ep1_3.mp3"]]);
  });

  it("撞到來源本身先 _converted；_converted 也在磁碟上就 _2", async () => {
    const d = disk("C:\\a\\a_converted.mp3");
    await expect(planOutPathsOnDisk(["C:\\a\\a.mp3"], opts, d.exists)).resolves.toEqual(["C:\\a\\a_2.mp3"]);
  });

  it("同一批兩個來源：磁碟上的檔與同批已分配的路徑都不能撞", async () => {
    const d = disk("C:\\a\\x.mp3");
    await expect(planOutPathsOnDisk(["C:\\a\\x.wav", "C:\\a\\x.flac"], opts, d.exists)).resolves.toEqual(["C:\\a\\x_2.mp3", "C:\\a\\x_3.mp3"]);
  });

  it("exists 失敗（後端沒有 paths_exist）就退回不看磁碟的排法", async () => {
    const srcs = ["C:\\a\\ep1.wav"];
    const boom = async () => {
      throw new Error("no cmd");
    };
    await expect(planOutPathsOnDisk(srcs, opts, boom)).resolves.toEqual(planOutPaths(srcs, opts));
  });
});
