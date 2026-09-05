import { t } from "./i18n";

/** ffmpeg 是從哪裡找到的。使用者最常問的是「它到底在用哪一個」，尤其在自己也裝了一份的時候。 */
export function ffmpegSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "bundled":
      return t("內建");
    case "custom":
      return t("自訂路徑");
    case "path":
      return t("系統 PATH");
    case "common":
      return t("常見安裝位置");
    default:
      return source ?? "";
  }
}

/**
 * 狀態列用的短版本號。ffmpeg -version 的字串常常很長：
 *   n8.1.2-50-g1a748fe2cd-20260904（BtbN 內建版）→ 8.1.2
 *   7.1-essentials_build-www.gyan.dev（gyan 版）  → 7.1
 * 完整字串留在 tooltip 裡。
 */
export function shortFfmpegVersion(version: string | null | undefined): string {
  const v = (version ?? "").trim();
  if (!v) return "";
  return v.replace(/^n/, "").split("-")[0];
}
