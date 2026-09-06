import { api } from "../api";
import { normalizeShowNotes, notesPrompt, notesSource, SHOW_NOTES_SCHEMA, type RawShowNotes, type ShowNotes } from "../analysis/shownotes";
import { t } from "../i18n";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";
import { edlFor } from "./rules";

/**
 * 節目筆記：把剪好的這一集交給地端 claude，要回摘要 / 章節 / 節錄 / 關鍵字。
 *
 * 走 `claude_structured`（帶 JSON schema）而不是聊天：這是一次性的結構化產出，
 * 不需要工具迴圈，也不該把它塞進助手的對話歷史裡。
 *
 * 時間全程用**成品時間**。逐字稿是來源時間軸，中間隔著整份 EDL ——
 * 剪掉 20 個贅字之後，來源 12:30 那句話在成品裡是 12:11。給 claude 的素材先換算好，
 * 它回來的時間戳再對節目長度驗一次，claude 完全不需要知道 EDL 的存在。
 */

const SYSTEM = "你是 podcast 製作人。只輸出符合 schema 的 JSON，不要加任何說明文字。用繁體中文。";

export class ShowNotesError extends Error {}

export async function generateShowNotes(mediaId: string): Promise<ShowNotes> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  if (!media) throw new ShowNotesError(t("找不到這個音檔"));

  const tr = useTranscript.getState().byMedia[mediaId] ?? null;
  if (!tr) throw new ShowNotesError(t("還沒有逐字稿：節目筆記是從逐字稿寫出來的，請先跑一次分析"));

  const edl = edlFor(mediaId);
  if (!edl) throw new ShowNotesError(t("還沒有剪輯結果"));

  const src = notesSource(tr, edl);
  if (!src.length) throw new ShowNotesError(t("剪完之後沒有留下任何句子"));

  const durationMs = edl.stats.outMs;
  const prompt = notesPrompt(src, { title: media.name, durationMs });
  const model = useSettings.getState().s.claude_model || null;

  let raw: unknown;
  try {
    raw = await api.claudeStructured(prompt, SHOW_NOTES_SCHEMA, model, SYSTEM, 240_000);
  } catch (e) {
    throw new ShowNotesError(e instanceof Error ? e.message : String(e));
  }

  const notes = normalizeShowNotes((raw ?? {}) as RawShowNotes, durationMs);
  // 全部被驗證擋掉 = claude 沒有給出可用的東西。回一份空的比回一份亂的好，但要說清楚。
  if (!notes.summary && !notes.chapters.length) throw new ShowNotesError(t("claude 沒有回出可用的節目筆記，再試一次或換個模型"));
  return notes;
}
