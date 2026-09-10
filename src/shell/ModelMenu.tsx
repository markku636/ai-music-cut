// 狀態列上的「AI 後端 / 模型」切換。
//
// 為什麼放在狀態列而不是只留在設定對話框裡：模型是**每次要跑判讀之前都可能想換**的東西
// —— 這一集很難判就先用 opus 跑一次，剩下的用 haiku 掃。埋在設定第二段裡等於每次三下點擊，
// 而狀態列那顆 `claude 2.1.201` 本來就是常駐的「AI 現在什麼狀態」，把模型接在它後面是同一件事。
//
// 四個後端：claude / codex（本機 CLI，吃訂閱登入）、anthropic-api / openai-api（HTTP 相容端點）。
// 選 codex 時 AI 助手仍走 claude —— 它要透過 App 內建的 MCP server 操作剪輯，而 codex 要連上
// 那個 server 得改使用者自己的 config.toml，App 寫不進去。API 供應商沒有這個限制：
// 助手的工具迴圈在 Rust 端自己跑，直接呼叫同一個 MCP bridge。
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";
import { isApiBackendId } from "../llm/presets";
import { Select } from "../ui/index";

const MODELS = ["opus", "sonnet", "haiku"] as const;
const BACKENDS = ["claude", "codex", "anthropic-api", "openai-api"] as const;

/** 後端在選單上的短名。API 供應商用協定名，不掛廠商 —— 端點可能是任何相容服務。 */
const BACKEND_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
};

/** 狀態列那顆按鈕上顯示的東西：CLI 顯示執行檔 + 版本，API 顯示 host。 */
function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** `claude 2.1.201 (Claude Code)` → `2.1.201`。狀態列只有一行，版本號後面那串沒有資訊量。 */
export function shortCliVersion(v: string | null | undefined): string {
  return (v ?? "").trim().split(/\s+/)[0] ?? "";
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${ok ? (warn ? "bg-warning" : "bg-success") : "bg-danger"}`} aria-hidden />;
}

export default function ModelMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT();
  const s = useSettings((x) => x.s);
  const save = useSettings((x) => x.save);
  const claude = useSettings((x) => x.claude);
  const codex = useSettings((x) => x.codex);
  const llm = useSettings((x) => x.llm);
  const probeCodex = useSettings((x) => x.probeCodex);
  const probeLlm = useSettings((x) => x.probeLlm);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  const backend = s.agent_backend || "claude";
  const isCodex = backend === "codex";
  const isApi = isApiBackendId(backend);
  const apiStatus = isApi ? llm[backend] : undefined;
  const model = s.claude_model || "sonnet";
  const reviewModel = s.claude_review_model || "haiku";
  const withReviewer = (s.judge_roles || "editor+reviewer").includes("reviewer");

  // codex 沒被選到就不去探它（每次探都是開一個 process）；打開選單時補一次，
  // 這樣「切過去之前先看得到裝了沒」。
  useEffect(() => {
    if (open && !codex) void probeCodex();
  }, [open, codex, probeCodex]);

  // API 後端不開 process，打開選單就重探一次（改過金鑰 / Base URL 後才會即時反映）。
  useEffect(() => {
    if (!open) return;
    for (const b of BACKENDS) {
      if (isApiBackendId(b)) void probeLlm(b);
    }
  }, [open, probeLlm]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = isCodex ? codex : claude;
  const cliName = isCodex ? "codex" : "claude";
  // CLI：綠 = 裝了也登入了；黃 = 裝了但沒登入（跑起來才會失敗，先警告）；紅 = 沒裝
  // API：綠 = 有端點有模型也有金鑰（或是地端）；黃 = 端點在但缺模型 / 金鑰；紅 = 連端點都沒設
  const ok = isApi ? !!apiStatus?.base : !!active?.installed;
  const warn = isApi ? !!apiStatus?.base && !apiStatus?.ready : ok && !active?.logged_in;

  return (
    <span ref={ref} className="relative flex items-center shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("點擊切換 AI 後端與模型")}
        className={`flex items-center gap-1.5 h-5 px-1 -mx-1 rounded-sm hover:text-fg/70 hover:bg-fg/5 ${open ? "text-fg/70 bg-fg/5" : ""}`}
      >
        <Dot ok={ok} warn={warn} />
        {isApi ? (
          <>
            {apiStatus?.base ? hostOf(apiStatus.base) : t("未設定")}
            {apiStatus?.model && <span className="text-fg/55">· {apiStatus.model}</span>}
          </>
        ) : (
          <>
            {cliName} {ok ? shortCliVersion(active?.version) : t("未安裝")}
            {!isCodex && ok && <span className="text-fg/55">· {model}</span>}
          </>
        )}
        <span className="text-[9px] leading-none text-fg/30">▾</span>
      </button>

      {open && (
        <div className="absolute bottom-7 left-0 z-40 w-72 rounded-md border border-fg/10 bg-elevated shadow-lg p-1.5 text-[12px]">
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-fg/35">{t("AI 後端")}</div>
          <div className="grid grid-cols-2 gap-1 px-0.5">
            {BACKENDS.map((b) => {
              const api = isApiBackendId(b) ? llm[b] : undefined;
              const cli = b === "codex" ? codex : b === "claude" ? claude : undefined;
              const dotOk = isApiBackendId(b) ? !!api?.base : !!cli?.installed;
              const dotWarn = isApiBackendId(b) ? !!api?.base && !api?.ready : !!cli?.installed && !cli?.logged_in;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => void save({ agent_backend: b })}
                  className={`h-7 px-1.5 rounded-sm inline-flex items-center justify-center gap-1.5 min-w-0 ${
                    backend === b ? "bg-accent/15 text-accent" : "text-fg/60 hover:bg-fg/5"
                  }`}
                >
                  <Dot ok={dotOk} warn={dotWarn} />
                  <span className="truncate">{BACKEND_LABEL[b]}</span>
                </button>
              );
            })}
          </div>

          {isApi ? (
            // 模型與金鑰在設定對話框裡填（這裡只給狀態，避免在小選單裡塞一整組表單）
            <div className="mt-1.5 rounded-sm border border-fg/10 px-2 py-1.5 text-[11px] text-fg/55 leading-snug space-y-0.5">
              <div className="truncate" title={apiStatus?.base || ""}>
                {apiStatus?.base || t("尚未設定 Base URL")}
              </div>
              <div>
                {t("模型")}：{apiStatus?.model || t("未指定")}
                {"　"}
                {apiStatus?.has_key ? t("金鑰：已設定") : apiStatus?.local ? t("金鑰：地端免用") : t("金鑰：未設定")}
              </div>
            </div>
          ) : isCodex ? (
            // 灰掉一個下拉而不解釋，只會讓人以為壞了
            <div className="mt-1.5 rounded-sm border border-fg/10 px-2 py-1.5 text-[11px] text-fg/55 leading-snug">
              {t("codex 的模型在它自己的設定裡指定（$CODEX_HOME/config.toml 的 model），App 寫不進去。")}
            </div>
          ) : (
            <div className="mt-1.5 space-y-1">
              <label className="flex items-center gap-2 px-0.5">
                <span className="w-16 shrink-0 text-fg/55">{t("判讀")}</span>
                <span className="flex-1 min-w-0">
                  <Select value={model} onChange={(e) => void save({ claude_model: e.target.value })}>
                    {MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </span>
              </label>
              <label className="flex items-center gap-2 px-0.5">
                <span className="w-16 shrink-0 text-fg/55">{t("審核")}</span>
                <span className="flex-1 min-w-0">
                  <Select value={reviewModel} disabled={!withReviewer} onChange={(e) => void save({ claude_review_model: e.target.value })}>
                    {MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </span>
              </label>
              {!withReviewer && <div className="px-0.5 text-[10px] text-fg/40">{t("目前只跑剪輯一個 agent，審核模型用不到。")}</div>}
            </div>
          )}

          <div className="mt-1.5 border-t border-fg/8 px-1.5 pt-1.5 text-[10px] text-fg/40 leading-snug">
            {isCodex
              ? t("AI 助手不受這裡影響 —— 它要透過 App 的 MCP server 操作剪輯，一律走 claude。")
              : isApi
                ? t("判讀、審核、節目筆記與 AI 助手都走這個 API；助手的工具直接接 App 內建的 MCP。")
                : t("判讀、審核、節目筆記與 AI 助手都吃這裡的設定。")}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="mt-1 w-full h-7 rounded-sm text-fg/60 hover:bg-fg/5 hover:text-fg/85"
          >
            {t("更多 AI 設定…")}
          </button>
        </div>
      )}
    </span>
  );
}
