// 狀態列上的「AI 後端 / 模型」切換。
//
// 為什麼放在狀態列而不是只留在設定對話框裡：模型是**每次要跑判讀之前都可能想換**的東西
// —— 這一集很難判就先用 opus 跑一次，剩下的用 haiku 掃。埋在設定第二段裡等於每次三下點擊，
// 而狀態列那顆 `claude 2.1.201` 本來就是常駐的「AI 現在什麼狀態」，把模型接在它後面是同一件事。
//
// 這裡只管**結構化產出**那條路（判讀 / 審核 / 節目筆記）。AI 助手不受後端設定影響：
// 它要透過 App 內建的 MCP server 操作剪輯，而 codex 要連上那個 server 得改使用者自己的
// config.toml，App 寫不進去 —— 所以助手一律走 claude，但它跟判讀共用同一個模型設定。
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";
import { Select } from "../ui/index";

const MODELS = ["opus", "sonnet", "haiku"] as const;

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
  const probeCodex = useSettings((x) => x.probeCodex);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  const backend = s.agent_backend || "claude";
  const isCodex = backend === "codex";
  const model = s.claude_model || "sonnet";
  const reviewModel = s.claude_review_model || "haiku";
  const withReviewer = (s.judge_roles || "editor+reviewer").includes("reviewer");

  // codex 沒被選到就不去探它（每次探都是開一個 process）；打開選單時補一次，
  // 這樣「切過去之前先看得到裝了沒」。
  useEffect(() => {
    if (open && !codex) void probeCodex();
  }, [open, codex, probeCodex]);

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
  // 綠 = 裝了也登入了；黃 = 裝了但沒登入（跑起來才會失敗，先警告）；紅 = 沒裝
  const ok = !!active?.installed;
  const warn = ok && !active?.logged_in;

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
        {cliName} {ok ? shortCliVersion(active?.version) : t("未安裝")}
        {!isCodex && ok && <span className="text-fg/55">· {model}</span>}
        <span className="text-[9px] leading-none text-fg/30">▾</span>
      </button>

      {open && (
        <div className="absolute bottom-7 left-0 z-40 w-72 rounded-md border border-fg/10 bg-bg shadow-lg p-1.5 text-[12px]">
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-fg/35">{t("結構化產出的後端")}</div>
          <div className="flex gap-1 px-0.5">
            {(["claude", "codex"] as const).map((b) => {
              const st = b === "codex" ? codex : claude;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => void save({ agent_backend: b })}
                  className={`flex-1 h-7 rounded-sm inline-flex items-center justify-center gap-1.5 ${
                    backend === b ? "bg-accent/15 text-accent" : "text-fg/60 hover:bg-fg/5"
                  }`}
                >
                  <Dot ok={!!st?.installed} warn={!!st?.installed && !st?.logged_in} />
                  {b === "codex" ? t("Codex") : t("Claude Code")}
                </button>
              );
            })}
          </div>

          {isCodex ? (
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
