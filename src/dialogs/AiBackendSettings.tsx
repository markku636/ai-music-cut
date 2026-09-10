// 設定對話框的「AI 後端」區塊：HTTP 供應商（Anthropic / OpenAI 相容）的連線設定 + 助手技能。
//
// 金鑰只寫進 OS keychain，前端拿不到明文 —— 所以輸入框永遠是空的，旁邊用「已設定 / 未設定」
// 表示狀態，要換就直接覆寫、要刪就按清除。
import { useEffect, useState } from "react";
import { Check, Plus, Trash2, Wand2 } from "lucide-react";
import { api, type AppSettings } from "../api";
import { Button, Field, Input, Select } from "../ui/index";
import { toast } from "../ui";
import Icon from "../ui/Icon";
import { useT } from "../i18n";
import { endpointOf, isApiBackendId, presetsFor, type LlmBackend } from "../llm/presets";
import { allSkills, addSkill, removeSkill, toggleSkill, updateSkill, type Skill } from "../assistant/skills";
import { useSettings } from "../store/settings";

/** 這個後端的 Base URL / 模型設定欄位名（兩組欄位長一樣，只有 key 不同）。 */
function fieldsOf(backend: LlmBackend): { base: keyof AppSettings; model: keyof AppSettings } {
  return backend === "anthropic-api"
    ? { base: "llm_anthropic_base_url", model: "llm_anthropic_model" }
    : { base: "llm_openai_base_url", model: "llm_openai_model" };
}

export default function AiBackendSettings({
  draft,
  patch,
  commit,
}: {
  draft: AppSettings;
  /** 只更新草稿（打字中）。 */
  patch: (p: Partial<AppSettings>) => void;
  /** 更新草稿並存檔（下拉、離開欄位時）。 */
  commit: (p: Partial<AppSettings>) => Promise<void>;
}) {
  const t = useT();
  const llm = useSettings((x) => x.llm);
  const probeLlm = useSettings((x) => x.probeLlm);
  const backend = draft.agent_backend || "claude";

  // 設定畫面獨立於「使用中的後端」：可以先把 API 設好，之後再切過去。
  const [target, setTarget] = useState<LlmBackend>(isApiBackendId(backend) ? backend : "openai-api");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const f = fieldsOf(target);
  const baseUrl = (draft[f.base] as string) ?? "";
  const model = (draft[f.model] as string) ?? "";
  const status = llm[target];

  useEffect(() => {
    setKey("");
    setModels([]);
    api.llmKeyStatus(target).then(setHasKey).catch(() => setHasKey(false));
    void probeLlm(target);
  }, [target, probeLlm]);

  const saveKey = async (value: string) => {
    try {
      await api.llmKeySet(target, value);
      setKey("");
      setHasKey(await api.llmKeyStatus(target).catch(() => false));
      await probeLlm(target);
      toast.success(value ? t("金鑰已存入系統金鑰庫") : t("金鑰已清除"));
    } catch {
      toast.error(t("金鑰寫入失敗"));
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const list = await api.llmListModels(target, baseUrl);
      setModels(list);
      if (list.length) toast.success(t("連線成功，取得 {n} 個模型", { n: list.length }));
      else toast.info(t("連得上，但這個端點沒有回模型清單（模型請自己填）"));
      await probeLlm(target);
    } catch {
      toast.error(t("測試失敗，請檢查 Base URL 與金鑰"));
    } finally {
      setTesting(false);
    }
  };

  const skills = allSkills(draft);
  const on = new Set(draft.assistant_skills_on ?? []);
  // 技能的名稱 / 內容打字中先留在本地，離開欄位才寫回設定檔（避免每敲一個字存一次）。
  const [edits, setEdits] = useState<Record<string, { name?: string; body?: string }>>({});
  const editOf = (id: string, field: "name" | "body", fallback: string) => edits[id]?.[field] ?? fallback;
  const setEdit = (id: string, field: "name" | "body", v: string) =>
    setEdits((m) => ({ ...m, [id]: { ...m[id], [field]: v } }));
  const flush = (id: string, field: "name" | "body") => {
    const v = edits[id]?.[field];
    if (v === undefined) return;
    setEdits((m) => {
      const next = { ...m, [id]: { ...m[id] } };
      delete next[id][field];
      return next;
    });
    void updateSkill(id, { [field]: v } as Partial<Pick<Skill, "name" | "body">>);
  };

  return (
    <div className="space-y-3">
      <Field
        label={t("AI 後端")}
        hint={t("claude / codex 用你自己的訂閱登入；API 後端直接打相容端點（地端的 Ollama / LM Studio 免金鑰）。判讀、審核、節目筆記與助手都走這裡選的後端。")}
      >
        <Select value={backend} onChange={(e) => void commit({ agent_backend: e.target.value })}>
          <option value="claude">{t("Claude Code（claude CLI）")}</option>
          <option value="codex">{t("Codex（codex CLI）")}</option>
          <option value="anthropic-api">{t("Anthropic 相容 API")}</option>
          <option value="openai-api">{t("OpenAI 相容 API")}</option>
        </Select>
      </Field>

      <div className="rounded-md border border-fg/10 p-2.5 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-fg/45 uppercase tracking-wide">{t("API 後端設定")}</span>
          <Select className="w-44" value={target} onChange={(e) => setTarget(e.target.value as LlmBackend)}>
            <option value="anthropic-api">{t("Anthropic 相容 API")}</option>
            <option value="openai-api">{t("OpenAI 相容 API")}</option>
          </Select>
        </div>

        <Field label={t("預設服務")} hint={t("選一個就帶入它的 Base URL；也可以自己填。")}>
          <Select
            value=""
            onChange={(e) => {
              const p = presetsFor(target).find((x) => x.id === e.target.value);
              if (p) void commit({ [f.base]: p.baseUrl } as Partial<AppSettings>);
            }}
          >
            <option value="">{t("（選擇以帶入）")}</option>
            {presetsFor(target).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.local ? t("（地端）") : ""} · {p.baseUrl}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={t("Base URL")}
          hint={baseUrl ? t("實際會打：{url}", { url: endpointOf(target, baseUrl) }) : t("結尾有沒有 /v1 都可以，自帶路徑（如 /anthropic）會照原樣使用。")}
        >
          <Input
            value={baseUrl}
            onChange={(e) => patch({ [f.base]: e.target.value } as Partial<AppSettings>)}
            onBlur={(e) => void commit({ [f.base]: e.target.value.trim() } as Partial<AppSettings>)}
            placeholder="https://api.openai.com/v1"
          />
        </Field>

        <Field
          label={t("API Key")}
          hint={hasKey ? t("已設定（存在系統金鑰庫，不會顯示明文）") : status?.local ? t("地端端點不需要金鑰。") : t("未設定。也可以用環境變數 ANTHROPIC_API_KEY / OPENAI_API_KEY。")}
        >
          <div className="flex gap-2">
            <Input type="password" className="flex-1" value={key} placeholder={hasKey ? "••••••••" : t("貼上金鑰")} onChange={(e) => setKey(e.target.value)} />
            <Button variant="secondary" disabled={!key.trim()} onClick={() => void saveKey(key.trim())}>
              {t("儲存")}
            </Button>
            {hasKey && (
              <Button variant="ghost" icon={Trash2} onClick={() => void saveKey("")}>
                {t("清除")}
              </Button>
            )}
          </div>
        </Field>

        <Field label={t("模型")} hint={t("按「測試連線」可從端點抓清單；抓不到就直接填模型名稱。")}>
          <div className="flex gap-2">
            {models.length > 0 ? (
              <Select className="flex-1" value={model} onChange={(e) => void commit({ [f.model]: e.target.value } as Partial<AppSettings>)}>
                <option value="">{t("（未指定）")}</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                className="flex-1"
                value={model}
                placeholder="gpt-5 / claude-sonnet-5 / qwen3…"
                onChange={(e) => patch({ [f.model]: e.target.value } as Partial<AppSettings>)}
                onBlur={(e) => void commit({ [f.model]: e.target.value.trim() } as Partial<AppSettings>)}
              />
            )}
            <Button variant="secondary" disabled={testing || !baseUrl.trim()} onClick={() => void test()}>
              {testing ? t("測試中…") : t("測試連線")}
            </Button>
          </div>
        </Field>

        {status && (
          <div className="text-[11px] text-fg/45">
            {status.ready ? t("這個後端已就緒。") : status.base ? t("還缺模型或金鑰。") : t("還沒設定 Base URL。")}
          </div>
        )}
      </div>

      <div className="rounded-md border border-fg/10 p-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-fg/45 uppercase tracking-wide">{t("助手技能")}</span>
          <span className="text-[11px] text-fg/35">{t("勾起來的會接在人設後面，可複選")}</span>
          <Button className="ml-auto" variant="ghost" icon={Plus} onClick={() => void addSkill(t("新技能"), "")}>
            {t("新增")}
          </Button>
        </div>
        <div className="text-[11px] text-fg/40 leading-snug">
          {t("人設（助手是誰）在「維護提示詞」裡改；技能是「這一集想怎麼剪」，可以隨時換。四種後端都吃同一份。")}
        </div>
        <div className="space-y-1.5">
          {skills.map((sk) => (
            <div key={sk.id} className="rounded-sm border border-fg/10 bg-inset/40 p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void toggleSkill(sk.id)}
                  title={on.has(sk.id) ? t("停用") : t("啟用")}
                  className={`w-4 h-4 rounded-xs border flex items-center justify-center shrink-0 ${
                    on.has(sk.id) ? "bg-accent border-accent text-white" : "border-fg/25 text-transparent"
                  }`}
                >
                  <Icon icon={Check} size={11} />
                </button>
                {sk.builtin ? (
                  <span className="text-[12px] text-fg/80">{sk.name}</span>
                ) : (
                  <Input
                    className="flex-1"
                    value={editOf(sk.id, "name", sk.name)}
                    onChange={(e) => setEdit(sk.id, "name", e.target.value)}
                    onBlur={() => flush(sk.id, "name")}
                  />
                )}
                {sk.builtin ? (
                  <Button className="ml-auto" variant="ghost" icon={Wand2} onClick={() => void addSkill(`${sk.name}（${t("自訂")}）`, sk.body)}>
                    {t("複製為自訂")}
                  </Button>
                ) : (
                  <Button className="ml-auto" variant="ghost" icon={Trash2} onClick={() => void removeSkill(sk.id)}>
                    {t("刪除")}
                  </Button>
                )}
              </div>
              {sk.builtin ? (
                <div className="text-[11px] text-fg/50 leading-relaxed pl-6">{sk.body}</div>
              ) : (
                <textarea
                  rows={3}
                  value={editOf(sk.id, "body", sk.body)}
                  onChange={(e) => setEdit(sk.id, "body", e.target.value)}
                  onBlur={() => flush(sk.id, "body")}
                  className="w-full resize-y rounded-sm bg-inset border border-fg/10 px-2 py-1.5 text-[12px] outline-none focus:border-accent/60"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
