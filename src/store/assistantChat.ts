import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, type ClaudeStreamEvent } from "../api";
import { uiLanguageLine } from "../i18n";
import { resolvePrompt } from "../analysis/prompts";
import { useSettings } from "./settings";

export interface ToolRow {
  name: string;
  result?: string;
  error?: boolean;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolRow[];
  error?: string;
  ts: number;
  durationMs?: number;
}

const STORAGE_KEY = "aicut:assistantChat";
const MAX_MSGS = 60;


interface AssistantChatStore {
  messages: ChatMsg[];
  sessionId: string | null;
  busy: boolean;
  reqId: string | null;
  /** 最近一次送出的提示 + 是否已因 session 失效重試過（只重試一次）。 */
  lastPrompt: string | null;
  retried: boolean;
  send: (prompt: string) => Promise<void>;
  cancel: () => Promise<void>;
  clear: () => void;
}

function load(): { messages: ChatMsg[]; sessionId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { messages?: ChatMsg[]; sessionId?: string | null };
      return { messages: Array.isArray(v.messages) ? v.messages.slice(-MAX_MSGS) : [], sessionId: v.sessionId ?? null };
    }
  } catch {
    /* ignore */
  }
  return { messages: [], sessionId: null };
}

function persist(s: { messages: ChatMsg[]; sessionId: string | null }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: s.messages.slice(-MAX_MSGS), sessionId: s.sessionId }));
  } catch {
    /* ignore */
  }
}

let listenerInstalled = false;

export const useAssistantChat = create<AssistantChatStore>((set, get) => {
  const init = load();
  const patchLast = (fn: (m: ChatMsg) => ChatMsg) =>
    set((s) => {
      const msgs = s.messages.slice();
      const i = msgs.length - 1;
      if (i >= 0 && msgs[i].role === "assistant") msgs[i] = fn(msgs[i]);
      return { messages: msgs };
    });

  const ensureListener = async () => {
    if (listenerInstalled) return;
    listenerInstalled = true;
    await listen<ClaudeStreamEvent>("claude-stream", (ev) => {
      const p = ev.payload;
      if (p.req_id !== get().reqId) return;
      switch (p.kind) {
        case "system":
          if (p.session_id) set({ sessionId: p.session_id });
          break;
        case "text":
          patchLast((m) => ({ ...m, text: m.text + (p.text ?? "") }));
          break;
        case "tool":
          patchLast((m) => ({ ...m, tools: [...m.tools, { name: p.tool ?? "tool" }] }));
          break;
        case "tool_result":
          patchLast((m) => {
            const tools = m.tools.slice();
            const i = tools.map((t) => t.result === undefined).lastIndexOf(true);
            if (i >= 0) tools[i] = { ...tools[i], result: p.text ?? "", error: p.is_error ?? false };
            return { ...m, tools };
          });
          break;
        case "result":
          if (p.session_id) set({ sessionId: p.session_id });
          patchLast((m) => ({ ...m, text: m.text.trim() ? m.text : (p.text ?? ""), durationMs: p.duration_ms, error: p.is_error ? (p.text ?? "錯誤") : m.error }));
          break;
        case "error":
          patchLast((m) => ({ ...m, error: p.text ?? "錯誤" }));
          break;
        case "done": {
          const last = get().messages[get().messages.length - 1];
          const failed = !!last?.error && !last.text.trim();
          const hadSession = !!get().sessionId;
          set({ busy: false, reqId: null });
          // 帶 --resume 失敗（session 可能是舊模型 / 已過期）→ 丟掉 session 重送一次
          if (failed && hadSession && !get().retried && get().lastPrompt) {
            const prompt = get().lastPrompt!;
            set((s) => ({ sessionId: null, retried: true, messages: s.messages.slice(0, -2) }));
            void get().send(prompt);
            return;
          }
          if (failed && hadSession) set({ sessionId: null });
          persist(get());
          break;
        }
      }
    });
  };

  return {
    messages: init.messages,
    sessionId: init.sessionId,
    busy: false,
    reqId: null,
    lastPrompt: null,
    retried: false,
    send: async (prompt) => {
      const text = prompt.trim();
      if (!text || get().busy) return;
      await ensureListener();
      const reqId = `req-${Date.now().toString(36)}`;
      const retried = get().retried && get().lastPrompt === text;
      set((s) => ({
        busy: true,
        reqId,
        lastPrompt: text,
        retried,
        messages: [
          ...s.messages,
          { id: `${reqId}-u`, role: "user" as const, text, tools: [], ts: Date.now() },
          { id: `${reqId}-a`, role: "assistant" as const, text: "", tools: [], ts: Date.now() },
        ].slice(-MAX_MSGS),
      }));
      const model = useSettings.getState().s.claude_model || "sonnet";
      // 助手是在跟剪輯的人講話，跟著介面語言
      const lang = uiLanguageLine();
      // 助手的人格設定可以在「提示詞」對話框改；語言指示永遠是執行期接上去的
      const base = resolvePrompt("assistant");
      const sys = lang ? `${base}\n${lang}` : base;
      try {
        await api.claudeSend(reqId, text, get().sessionId, model, "agent", sys);
      } catch (e) {
        patchLast((m) => ({ ...m, error: errMessage(e) }));
        set({ busy: false, reqId: null });
        persist(get());
      }
    },
    cancel: async () => {
      const id = get().reqId;
      if (!id) return;
      await api.claudeCancel(id).catch(() => {});
      patchLast((m) => ({ ...m, error: m.error ?? "已取消" }));
      set({ busy: false, reqId: null });
      persist(get());
    },
    clear: () => {
      set({ messages: [], sessionId: null, lastPrompt: null, retried: false });
      persist({ messages: [], sessionId: null });
    },
  };
});
