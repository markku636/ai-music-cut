// 專案檔（*.aicut.json）格式：schemaVersion 版本化；後端只搬運 JSON，結構在此定義。
// 硬性規則：**不含任何祕密**（API key 只在 OS keychain）——format.test.ts 會斷言。
import type { MediaProbe } from "../api";

export const SCHEMA_VERSION = 1 as const;

export interface ProjectMediaV1 {
  id: string;
  path: string;
  name: string;
  fingerprint: string;
  probe: MediaProbe | null;
}

export interface ProjectSettingsV1 {
  aggressiveness: number;
  targetLufs: number;
  /** 輸出時逐段音量平衡（簡易面板的「音量弄整齊」）。缺 = true（舊專案檔）。 */
  leveling?: boolean;
}

/** 每個媒體的分析產物（逐字稿 / 候選 / 決策）。M2+ 逐步填入，用 unknown 保留擴充彈性。 */
export type MediaAnalysisV1 = Record<string, unknown>;

export interface ProjectFileV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  app: { name: string; version: string };
  createdAt: string;
  updatedAt: string;
  media: ProjectMediaV1[];
  activeMediaId: string | null;
  settings: ProjectSettingsV1;
  analysis: Record<string, MediaAnalysisV1>;
}

export interface ProjectSnapshot {
  media: ProjectMediaV1[];
  activeMediaId: string | null;
  settings: ProjectSettingsV1;
  analysis: Record<string, MediaAnalysisV1>;
}

export function buildProjectFile(
  snap: ProjectSnapshot,
  app: { name: string; version: string },
  prev?: Pick<ProjectFileV1, "createdAt"> | null,
  now: Date = new Date(),
): ProjectFileV1 {
  const iso = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    app,
    createdAt: prev?.createdAt ?? iso,
    updatedAt: iso,
    media: snap.media.map((m) => ({ id: m.id, path: m.path, name: m.name, fingerprint: m.fingerprint, probe: m.probe })),
    activeMediaId: snap.activeMediaId,
    settings: { ...snap.settings },
    analysis: snap.analysis,
  };
}

export class ProjectFormatError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 解析並驗證專案檔；不合法丟 ProjectFormatError（訊息可直接顯示）。 */
export function parseProjectFile(doc: unknown): ProjectFileV1 {
  if (!isRecord(doc)) throw new ProjectFormatError("專案檔不是 JSON 物件");
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new ProjectFormatError(`不支援的專案檔版本 ${String(doc.schemaVersion)}（本版只支援 ${SCHEMA_VERSION}）`);
  }
  if (!Array.isArray(doc.media)) throw new ProjectFormatError("專案檔缺少 media 陣列");
  const media: ProjectMediaV1[] = [];
  for (const m of doc.media) {
    if (!isRecord(m) || typeof m.path !== "string" || typeof m.id !== "string") {
      throw new ProjectFormatError("專案檔的 media 項目格式錯誤");
    }
    media.push({
      id: m.id,
      path: m.path,
      name: typeof m.name === "string" ? m.name : m.path.split(/[\\/]/).pop() ?? m.path,
      fingerprint: typeof m.fingerprint === "string" ? m.fingerprint : "",
      probe: isRecord(m.probe) ? (m.probe as unknown as MediaProbe) : null,
    });
  }
  const settings = isRecord(doc.settings) ? doc.settings : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    app: isRecord(doc.app) ? { name: String(doc.app.name ?? ""), version: String(doc.app.version ?? "") } : { name: "", version: "" },
    createdAt: typeof doc.createdAt === "string" ? doc.createdAt : new Date().toISOString(),
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : new Date().toISOString(),
    media,
    activeMediaId: typeof doc.activeMediaId === "string" ? doc.activeMediaId : media[0]?.id ?? null,
    settings: {
      aggressiveness: clampNum(settings.aggressiveness, 0, 100, 50),
      targetLufs: clampNum(settings.targetLufs, -30, -8, -16),
      leveling: settings.leveling === undefined ? true : settings.leveling === true,
    },
    analysis: isRecord(doc.analysis) ? (doc.analysis as Record<string, MediaAnalysisV1>) : {},
  };
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** 專案檔預設檔名：<媒體名>.aicut.json。 */
export function defaultProjectFileName(mediaName: string | null): string {
  const base = (mediaName ?? "untitled").replace(/\.[^.]+$/, "");
  return `${base}.aicut.json`;
}
