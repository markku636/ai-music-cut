import { useEffect, useRef, useState } from "react";
import { ChevronRight, Eraser, Send, Sparkles, Square, Wrench } from "lucide-react";
import Icon from "../ui/Icon";
import { IconButton } from "../ui/index";
import { useT } from "../i18n";
import { useAssistant } from "../store/assistant";
import { useAssistantChat, type ChatMsg } from "../store/assistantChat";
import { useSettings } from "../store/settings";
import { isApiBackendId } from "../llm/presets";
import { allSkills, toggleSkill } from "./skills";
import { selectActiveMedia, useProject } from "../store/project";

const WIDTH = 380;

const SUGGESTIONS = ["幫我看一下目前的剪輯狀況", "把句首以外的「就是」都剪掉", "待決的建議逐一告訴我你的看法", "激進度調到 70 再看看會剪多少"];

export default function AssistantPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const open = useAssistant((s) => s.open);
  const setOpen = useAssistant((s) => s.setOpen);
  const messages = useAssistantChat((s) => s.messages);
  const busy = useAssistantChat((s) => s.busy);
  const send = useAssistantChat((s) => s.send);
  const cancel = useAssistantChat((s) => s.cancel);
  const clear = useAssistantChat((s) => s.clear);
  const claude = useSettings((s) => s.claude);
  const settings = useSettings((s) => s.s);
  const llm = useSettings((s) => s.llm);
  const active = useProject(selectActiveMedia);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  if (!embedded && !open) return null;

  const submit = () => {
    const v = input.trim();
    if (!v || busy) return;
    setInput("");
    void send(v);
  };
  // 助手在 codex 後端仍走 claude（它要連 App 內建的 MCP server），所以只有 API 後端才看 llm 狀態。
  const backend = settings.agent_backend || "claude";
  const apiBackend = isApiBackendId(backend) ? backend : null;
  const ready = apiBackend ? !!llm[apiBackend]?.ready : !!claude?.installed;
  const skills = allSkills(settings);
  const skillsOn = new Set(settings.assistant_skills_on ?? []);

  return (
    <div
      className={embedded ? "flex-1 min-h-0 flex flex-col text-sm" : "shrink-0 bg-panel border-l border-fg/10 flex flex-col text-sm min-h-0"}
      style={embedded ? undefined : { width: WIDTH }}
    >
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10">
        <Icon icon={Sparkles} size={14} className="text-accent" />
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("AI 助手")}</span>
        <span className="text-[11px] text-fg/35 truncate">
          {apiBackend ? llm[apiBackend]?.model || t("未指定模型") : claude?.version ? `claude ${claude.version.split(" ")[0]}` : ""}
        </span>
        <IconButton icon={Eraser} label={t("清除對話")} iconSize={14} box="w-6 h-6" className="ml-auto" onClick={clear} disabled={busy} />
        <IconButton icon={ChevronRight} label={t("收合面板")} iconSize={16} box="w-6 h-6" onClick={() => setOpen(false)} />
      </div>

      {!ready && (
        <div className="px-3 py-2 text-[11px] text-warning/90 bg-warning/10 border-b border-fg/10 leading-relaxed">
          {apiBackend
            ? llm[apiBackend]?.base
              ? t("這個 API 後端還缺模型或金鑰，請到設定的「AI 後端設定」補上。")
              : t("這個 API 後端還沒設定 Base URL，請到設定的「AI 後端設定」填。")
            : claude
              ? t("找不到 claude CLI 或尚未登入：請安裝 Claude Code 並執行 claude login。")
              : t("偵測 claude CLI 中…")}
        </div>
      )}

      <div ref={listRef} className="flex-1 min-h-0 overflow-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="text-xs text-fg/40 leading-relaxed space-y-2">
            <p>{t("我可以直接操作剪輯決策（接受 / 拒絕候選、新增剪除、調激進度），也能解釋為什麼某段建議剪或不剪。")}</p>
            {!active && <p>{t("先開啟並分析一個音檔。")}</p>}
            <div className="flex flex-wrap gap-1 pt-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} disabled={!ready || !active || busy} className="text-[11px] px-2 py-1 rounded-sm border border-fg/10 hover:bg-fg/5 disabled:opacity-40 text-left">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {busy && messages[messages.length - 1]?.text === "" && messages[messages.length - 1]?.tools.length === 0 && (
          <div className="text-xs text-fg/40 animate-pulse">{t("思考中…")}</div>
        )}
      </div>

      <div className="shrink-0 border-t border-fg/10 p-2 space-y-1.5">
        {skills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-fg/30 mr-0.5">{t("技能")}</span>
            {skills.map((sk) => {
              const on = skillsOn.has(sk.id);
              return (
                <button
                  key={sk.id}
                  type="button"
                  onClick={() => void toggleSkill(sk.id)}
                  title={sk.body}
                  className={`px-1.5 py-0.5 rounded-full border text-[10px] ${
                    on ? "border-accent/60 bg-accent/15 text-accent" : "border-fg/10 text-fg/45 hover:text-fg/70 hover:bg-fg/5"
                  }`}
                >
                  {sk.name}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex gap-1 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={ready ? t("例：把 10 分鐘後的「就是」都剪掉，但句首的留著") : apiBackend ? t("需要先設定 API 後端") : t("需要 claude CLI")}
            disabled={!ready}
            rows={2}
            className="flex-1 resize-none rounded-sm bg-inset border border-fg/10 px-2 py-1.5 text-sm outline-none focus:border-accent/60 disabled:opacity-50"
          />
          {busy ? (
            <IconButton icon={Square} label={t("停止")} iconSize={16} box="w-8 h-8" onClick={() => void cancel()} />
          ) : (
            <IconButton icon={Send} label={t("送出（Enter）")} iconSize={16} box="w-8 h-8" onClick={submit} disabled={!ready || !input.trim()} />
          )}
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: ChatMsg }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[92%] rounded-md bg-accent/15 text-fg/90 px-3 py-1.5 whitespace-pre-wrap text-sm">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {m.tools.length > 0 && (
        <div className="space-y-0.5">
          {m.tools.map((tl, i) => (
            <div key={i} className={`text-[11px] flex items-start gap-1.5 ${tl.error ? "text-danger" : "text-fg/45"}`}>
              <Icon icon={Wrench} size={11} className="mt-0.5 shrink-0" />
              <span className="mono">{tl.name.replace(/^mcp__aicut__/, "")}</span>
              {tl.result !== undefined && <span className="truncate text-fg/30" title={tl.result}>{tl.result.slice(0, 80)}</span>}
            </div>
          ))}
        </div>
      )}
      {m.text && <div className="text-sm text-fg/85 leading-relaxed whitespace-pre-wrap">{renderLite(m.text)}</div>}
      {m.error && <div className="text-xs text-danger">{m.error}</div>}
      {m.durationMs != null && <div className="text-[10px] text-fg/25 mono">{(m.durationMs / 1000).toFixed(1)}s</div>}
    </div>
  );
}

/** 極簡 markdown：`code`、**bold**；其餘原樣（whitespace-pre-wrap 保留換行 / 條列）。 */
function renderLite(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`")) return <code key={i} className="mono text-[12px] bg-well px-1 rounded-xs">{p.slice(1, -1)}</code>;
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    return <span key={i}>{p}</span>;
  });
}
