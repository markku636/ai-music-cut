// 成品要寫到哪裡 —— 尤其是「一次跑好幾集、輸出到同一個資料夾」的時候。
//
// podcast 的檔案結構常常是 ep01/recording.wav、ep02/recording.wav。
// 只用檔名算的話兩集都得到 recording_cut.mp3，第二集**安靜地蓋掉第一集**：
// 使用者跑完看到一個檔案，以為是自己選錯了。
import { describe, expect, it } from "vitest";
import { defaultOutPath } from "./render";
import type { MediaItem } from "../store/project";

const m = (path: string, name?: string): MediaItem =>
  ({ id: path, name: name ?? path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1), path }) as MediaItem;

describe("defaultOutPath", () => {
  it("單檔：來源旁邊、加 _cut", () => {
    expect(defaultOutPath(m("D:/pod/ep01/recording.wav"), "mp3", null)).toBe("D:/pod/ep01/recording_cut.mp3");
  });

  it("指定輸出資料夾", () => {
    expect(defaultOutPath(m("D:/pod/ep01/recording.wav"), "mp3", "D:/out")).toBe("D:/out/recording_cut.mp3");
  });

  it("不傳 taken 時行為跟以前一樣（同名就是同一條路徑）", () => {
    const a = defaultOutPath(m("D:/pod/ep01/recording.wav"), "mp3", "D:/out");
    const b = defaultOutPath(m("D:/pod/ep02/recording.wav"), "mp3", "D:/out");
    expect(a).toBe(b);
  });

  it("批次：不同資料夾的同名檔不會蓋掉彼此", () => {
    const taken = new Set<string>();
    const a = defaultOutPath(m("D:/pod/ep01/recording.wav"), "mp3", "D:/out", taken);
    const b = defaultOutPath(m("D:/pod/ep02/recording.wav"), "mp3", "D:/out", taken);
    const c = defaultOutPath(m("D:/pod/ep03/recording.wav"), "mp3", "D:/out", taken);
    expect(a).toBe("D:/out/recording_cut.mp3");
    expect(b).toBe("D:/out/recording_cut_2.mp3");
    expect(c).toBe("D:/out/recording_cut_3.mp3");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("Windows 大小寫不分：Recording.wav 與 recording.wav 也算撞名", () => {
    const taken = new Set<string>();
    const a = defaultOutPath(m("D:/pod/a/Recording.WAV", "Recording.WAV"), "mp3", "D:/out", taken);
    const b = defaultOutPath(m("D:/pod/b/recording.wav"), "mp3", "D:/out", taken);
    expect(a.toLowerCase()).not.toBe(b.toLowerCase());
  });

  it("不會蓋掉這一批自己的來源檔（對著上一輪的成品資料夾再跑一次）", () => {
    // 上一輪產出的 recording_cut.mp3 這次被當成來源選進來了
    const sources = new Set(["d:/out/recording_cut.mp3"]);
    const taken = new Set<string>();
    const out = defaultOutPath(m("D:/out/recording_cut.mp3"), "mp3", "D:/out", taken, sources);
    // base 變成 recording_cut，所以第一個候選是 recording_cut_cut.mp3 —— 本來就不撞名
    expect(out).toBe("D:/out/recording_cut_cut.mp3");
    expect(out.toLowerCase()).not.toBe("d:/out/recording_cut.mp3");
  });

  it("輸出剛好等於同批另一個來源時要讓開（不然跑到一半輸入就沒了）", () => {
    // 同一批裡既有 a.wav，也有別人上一輪產出的 a_cut.mp3
    const sources = new Set(["d:/out/a_cut.mp3"]);
    const out = defaultOutPath(m("D:/pod/a.wav"), "mp3", "D:/out", new Set<string>(), sources);
    expect(out.toLowerCase()).not.toBe("d:/out/a_cut.mp3");
    expect(out).toBe("D:/out/a_cut_2.mp3");
  });

  it("反斜線路徑也對", () => {
    const taken = new Set<string>();
    expect(defaultOutPath(m("D:\\pod\\ep01\\rec.wav", "rec.wav"), "mp3", "D:\\out", taken)).toBe("D:\\out\\rec_cut.mp3");
    expect(defaultOutPath(m("D:\\pod\\ep02\\rec.wav", "rec.wav"), "mp3", "D:\\out", taken)).toBe("D:\\out\\rec_cut_2.mp3");
  });
});
