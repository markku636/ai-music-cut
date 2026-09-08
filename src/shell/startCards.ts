import { Circle, FileMusic, Mic, Music, Wand2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { WorkProfile } from "../store/ui";

/**
 * 開始畫面「你想做什麼？」的卡片。點卡片 = 設 profile → 開檔 → （可選）跑一個指令。
 * `requires` 指到的指令還沒登記時卡片不出現（錄音要到 R8 才有）。
 */
export interface StartCard {
  id: string;
  /** zh key */
  title: string;
  /** zh key：一句說明 */
  line: string;
  icon: LucideIcon;
  profile: WorkProfile;
  /** 開檔成功後接著跑的指令 id。 */
  after?: string;
  /** 沒登記這個指令就不顯示這張卡。 */
  requires?: string;
  /** 點卡片先選檔，把選到的檔直接帶進這個對話框（不加進專案的媒體清單）。 */
  pickInto?: "convert";
  /** 卡片下方的第二個小動作：zh key + 指令 id。 */
  secondary?: { label: string; command: string };
}

export const START_CARDS: StartCard[] = [
  { id: "podcast", title: "剪 Podcast（自動去贅字）", line: "開檔後自動找出嗯、呃、重講並剪掉", icon: Mic, profile: "podcast", after: "ai.analyze" },
  { id: "denoise", title: "把雜音去掉", line: "壓掉背景嘶聲、冷氣聲、低頻隆隆", icon: Wand2, profile: "repair" },
  { id: "music", title: "剪音樂", line: "拖一段、剪掉或只留一段、加淡入淡出", icon: Music, profile: "music" },
  // 轉檔不用先把檔案開進專案：選檔後直接帶進轉檔對話框；合併走卡片下方的小連結
  { id: "convert", title: "轉檔・合併", line: "換成 mp3 / flac，把影片的聲音抽出來，或把幾個檔接成一個", icon: FileMusic, profile: "convert", requires: "file.convert", pickInto: "convert", secondary: { label: "把幾個檔接成一個（合併）…", command: "file.merge" } },
  { id: "record", title: "錄音", line: "先錄一段，再直接剪", icon: Circle, profile: "record", requires: "record.new", after: "record.new" },
];
