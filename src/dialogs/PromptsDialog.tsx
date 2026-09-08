import { useMemo, useState } from "react";
import { AlertTriangle, Copy, Download, RotateCcw, ScrollText, Upload } from "lucide-react";
import { promptDefault, promptSpecs, type PromptId } from "../analysis/prompts";
import { Button, Modal, Textarea } from "../ui/index";
import { copyToClipboard, toast } from "../ui";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";

/**
 * 提示詞維護。
 *
 * 這些字串就是 AI 的行為本身 —— 判讀鬆緊、審核立場、節目筆記的口氣。
 * 寫死在原始碼裡等於「要調就得改程式再編譯一次」，而提示詞正是最需要反覆試的東西。
 *
 * 三個刻意的設計：
 * - **只存被改過的那幾條**。全部存下來的話，之後改進了預設值，
 *   舊使用者的設定檔會把舊版本永遠凍在那裡，而且完全無感。
 * - **每一條都寫清楚「誰在用」「改壞了會怎樣」**。要調的是行為不是字串，
 *   不講清楚等於叫人盲改。
 * - **匯出 / 匯入**：調好的一套提示詞是有價值的東西，應該能存起來、能給別人。
 */
export default function PromptsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const overrides = useSettings((s) => s.s.prompt_overrides ?? {});
  const save = useSettings((s) => s.save);
  const specs = useMemo(() => promptSpecs(), []);
  const [active, setActive] = useState<PromptId>(specs[0].id);
  const spec = specs.find((s) => s.id === active)!;
  // 編輯中的內容獨立於已存的：邊打字邊寫設定檔會很吵，也會讓「還原」失去意義
  const [draft, setDraft] = useState<Record<string, string>>({});
  const text = draft[active] ?? overrides[active] ?? spec.default;
  const dirty = text !== (overrides[active] ?? spec.default);
  const changed = text.trim() !== "" && text !== spec.default;

  const commit = async (id: PromptId, value: string) => {
    const next = { ...overrides };
    // 跟預設一樣就把這條刪掉，而不是存一份一模一樣的 ——
    // 存下來的話這條就再也收不到未來對預設值的改進了
    if (value.trim() === "" || value === promptDefault(id)) delete next[id];
    else next[id] = value;
    await save({ prompt_overrides: next });
  };

  const exportAll = async () => {
    const payload = JSON.stringify({ app: "ai-music-cut" /* 匯出檔的識別字串，改名後刻意不動（舊匯出檔要能再匯入） */, kind: "prompts", overrides }, null, 2);
    await copyToClipboard(payload, t("已複製提示詞設定（JSON）"));
  };

  const importAll = async () => {
    const raw = window.prompt(t("貼上先前匯出的提示詞 JSON"));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { overrides?: Record<string, string> };
      const incoming = parsed.overrides ?? {};
      const valid = Object.fromEntries(Object.entries(incoming).filter(([k]) => specs.some((s) => s.id === k)));
      const dropped = Object.keys(incoming).length - Object.keys(valid).length;
      await save({ prompt_overrides: valid });
      setDraft({});
      toast.success(
        dropped > 0
          ? t("已匯入 {n} 條（略過 {d} 條不認得的）").replace("{n}", String(Object.keys(valid).length)).replace("{d}", String(dropped))
          : t("已匯入 {n} 條").replace("{n}", String(Object.keys(valid).length)),
      );
    } catch {
      toast.error(t("這不是有效的 JSON"));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("提示詞")}
      icon={ScrollText}
      size="lg"
      footer={
        <>
          <Button variant="ghost" icon={Upload} onClick={() => void importAll()}>
            {t("匯入")}
          </Button>
          <Button variant="ghost" icon={Download} onClick={() => void exportAll()}>
            {t("匯出")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={() => void commit(active, text)}>
            {t("儲存這一條")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-1">
          {specs.map((s) => {
            const isChanged = (overrides[s.id] ?? "").trim() !== "" && overrides[s.id] !== s.default;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                className={`rounded-sm px-2 h-7 text-[12px] inline-flex items-center gap-1 ${
                  active === s.id ? "bg-accent/15 text-accent" : "text-fg/60 hover:bg-fg/8"
                }`}
              >
                {s.label}
                {isChanged && <span className="text-[9px] rounded-full bg-warning/25 text-warning px-1">{t("已改")}</span>}
              </button>
            );
          })}
        </div>

        <div className="rounded-md border border-fg/10 px-3 py-2 space-y-1 text-[11px]">
          <div className="text-fg/70">{spec.usedBy}</div>
          <div className="flex items-start gap-1.5 text-warning/90">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{spec.caution}</span>
          </div>
        </div>

        <Textarea
          rows={16}
          value={text}
          spellCheck={false}
          onChange={(e) => setDraft((d) => ({ ...d, [active]: e.target.value }))}
          className="font-mono text-[12px] leading-6"
        />

        <div className="flex items-center gap-2 text-[11px] text-fg/50">
          <span className="tabular-nums">{t("{n} 字").replace("{n}", String(text.length))}</span>
          {changed && <span className="text-warning">{t("與預設不同")}</span>}
          {dirty && <span className="text-accent">{t("尚未儲存")}</span>}
          <span className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              icon={Copy}
              onClick={() => void copyToClipboard(text, t("已複製"))}
            >
              {t("複製")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              disabled={!changed && !dirty}
              onClick={() => {
                setDraft((d) => ({ ...d, [active]: spec.default }));
                void commit(active, spec.default);
                toast.info(t("已還原成預設"));
              }}
            >
              {t("還原預設")}
            </Button>
          </span>
        </div>

        <p className="text-[11px] text-fg/45">
          {t("輸出語言不用寫在提示詞裡 —— 那是依節目 / 介面語言在執行期自動接上去的。清空一條等於還原預設。")}
        </p>
      </div>
    </Modal>
  );
}
