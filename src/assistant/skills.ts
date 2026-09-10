// 助手的「技能」：可重複套用的提示詞範本，勾起來就接在人設（提示詞對話框裡的「AI 助手」那條）後面。
//
// 為什麼跟人設分開：人設是「這個助手是誰」，一整個 App 只有一份；技能是「這一集想怎麼剪」，
// 會換來換去（這集保守、下集狠一點）。做成一份長提示詞的話，每次改都要重讀整段、也不好切換。
//
// 內建技能**不存進設定檔**，才能跟著版本更新；使用者自己寫的存 `assistant_skills`
// （JSON 字串陣列，形狀由這裡定義並自己驗證，同 project_templates 的作法）。
// 勾選狀態存 `assistant_skills_on`。
import { api, type AppSettings } from "../api";
import { useSettings } from "../store/settings";

export interface Skill {
  id: string;
  name: string;
  body: string;
  /** 內建範本：唯讀，只能勾選或「複製為自訂」。 */
  builtin?: boolean;
}

export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    id: "builtin:conservative",
    name: "保守剪輯",
    body: "只動明顯的贅字與整句重複。語氣詞、停頓、換氣一律留著；不確定的就列出來問我，不要自己剪。",
    builtin: true,
  },
  {
    id: "builtin:aggressive-fillers",
    name: "嚴格贅字",
    body: "口頭禪與語尾詞（就是、然後、對、那個、欸）連句首都剪，句子讀起來要乾淨俐落；但不要動到有內容的句子。",
    builtin: true,
  },
  {
    id: "builtin:shownotes-casual",
    name: "節目筆記口語化",
    body: "寫節目筆記時用聊天的口氣，不要條列式官腔；章節標題用聽眾會搜尋的說法，不要「第一段」這種編號。",
    builtin: true,
  },
  {
    id: "builtin:explain-first",
    name: "動手前先說明",
    body: "每次要改剪輯之前，先用一兩句話說你打算做什麼、影響幾秒，做完再回報實際結果。不要一次連做五件事。",
    builtin: true,
  },
];

/** 從設定檔的 JSON 字串陣列讀出自訂技能（讀壞的濾掉，不讓一筆壞資料弄掉整份）。 */
export function parseCustomSkills(raw: string[] | undefined): Skill[] {
  const out: Skill[] = [];
  for (const s of raw ?? []) {
    try {
      const v = JSON.parse(s) as Partial<Skill>;
      if (v && typeof v.id === "string" && typeof v.name === "string" && typeof v.body === "string") {
        out.push({ id: v.id, name: v.name, body: v.body });
      }
    } catch {
      /* 壞掉的那筆略過 */
    }
  }
  return out;
}

export function serializeSkill(s: Skill): string {
  return JSON.stringify({ id: s.id, name: s.name, body: s.body });
}

/** 內建 + 自訂（內建在前）。 */
export function allSkills(settings: AppSettings): Skill[] {
  return [...BUILTIN_SKILLS, ...parseCustomSkills(settings.assistant_skills)];
}

export function activeSkills(settings: AppSettings): Skill[] {
  const on = new Set(settings.assistant_skills_on ?? []);
  return allSkills(settings).filter((s) => on.has(s.id));
}

/** 人設 + 勾選中的技能 → 送出的系統提示詞。 */
export function composeSystemPrompt(persona: string, skills: Skill[]): string {
  const parts = [persona.trim()].filter(Boolean);
  for (const s of skills) {
    if (s.body.trim()) parts.push(`[技能：${s.name}]\n${s.body.trim()}`);
  }
  return parts.join("\n\n");
}

/** 目前勾選中的技能（供 assistantChat 送出時取用）。 */
export function currentSkills(): Skill[] {
  return activeSkills(useSettings.getState().s);
}

// ---- 設定檔寫入（都走 settings.save，會樂觀更新 UI）----

export async function toggleSkill(id: string): Promise<void> {
  const s = useSettings.getState();
  const on = s.s.assistant_skills_on ?? [];
  const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
  await s.save({ assistant_skills_on: next });
}

export async function addSkill(name: string, body: string): Promise<string> {
  const s = useSettings.getState();
  // 不用 Date.now() 以外的隨機源：技能 id 只需要在這台機器上唯一。
  const id = `skill:${Date.now().toString(36)}`;
  const next = [...(s.s.assistant_skills ?? []), serializeSkill({ id, name, body })];
  await s.save({ assistant_skills: next });
  return id;
}

export async function updateSkill(id: string, patch: Partial<Pick<Skill, "name" | "body">>): Promise<void> {
  const s = useSettings.getState();
  const list = parseCustomSkills(s.s.assistant_skills).map((x) => (x.id === id ? { ...x, ...patch } : x));
  await s.save({ assistant_skills: list.map(serializeSkill) });
}

export async function removeSkill(id: string): Promise<void> {
  const s = useSettings.getState();
  const list = parseCustomSkills(s.s.assistant_skills).filter((x) => x.id !== id);
  const on = (s.s.assistant_skills_on ?? []).filter((x) => x !== id);
  await s.save({ assistant_skills: list.map(serializeSkill), assistant_skills_on: on });
}

/** 設定畫面的「測試連線」：同時當模型清單來源。 */
export async function fetchModels(backend: string, baseUrl: string): Promise<string[]> {
  return api.llmListModels(backend, baseUrl);
}
