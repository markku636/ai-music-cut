import { AUDIO_EXTENSIONS } from "../brand";

/** 最近開啟清單的純函式：專案檔與音檔混在同一份清單裡。 */

export type RecentKind = "project" | "audio";

export const RECENT_MAX = 10;

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function kindOf(path: string): RecentKind {
  if (path.endsWith(".aicut.json")) return "project";
  return "audio";
}

export function isOpenablePath(path: string): boolean {
  if (kindOf(path) === "project") return true;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

/** 放到最前面、去重、最多 RECENT_MAX 筆。 */
export function pushRecent(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_MAX);
}

export function removeRecent(list: readonly string[], path: string): string[] {
  return list.filter((p) => p !== path);
}
