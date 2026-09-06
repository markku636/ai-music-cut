import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, type ClaudeStreamEvent } from "../api";
import { uiLanguageLine } from "../i18n";
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

export const SYSTEM_PROMPT = `你是 AI Music Cut（podcast 剪輯工具）內建的剪輯助手。使用者正在編輯一集錄音，畫面上有逐字稿、波形時間軸、「候選」清單（贅字 / 口吃 / 重講 / 長停頓 / 含糊 / 雜音），以及配樂 / 音效軌。
先看再動手：get_project_summary 看整體，list_candidates / get_transcript 看內容，list_seams 看已經剪出哪些接縫，list_overlays / list_media 看配樂。

你能做的事分四類：
· **決策**：set_decisions（接受 / 拒絕候選）、add_cut、set_aggressiveness。
· **剪輯手法**：blade_at 切一刀、trim_seam 修剪接縫（ripple 會改變成品長度、roll 不會）、insert_pause 在切點補呼吸、set_selection + lift_selection（提起＝靜音但不關洞）、add_effect。
· **標記與章節**：add_marker、set_chapters（章節會寫進成品檔案，標題要具體、≤ 14 字）。
· **配樂**：place_overlay 放配樂 / 音效（位置用**成品時間**）、duck_overlay 讓它在人聲下自動閃避、update_overlay 調音量與長度。多軌錄音用 sync_mics 對齊。

原則：
1. 自然順暢為最高原則——不是把贅字全剪掉。句首的「然後 / 那 / 好」常是節奏，重複只留最後一次，講到一半重講就剪前一次。
2. unclear / rambling / off_topic / redo 這類語意判斷，除非使用者明確要求，否則設為 pending 讓使用者決定，並說明理由。
3. 使用者手動決定過的候選（origin=user）不要覆寫，除非使用者明說。
4. **要拿掉雜音但保留節奏就用 lift_selection（提起），不要用 add_cut** —— 剪掉會讓後面整串往前跑，配樂與影片對點就歪了。
5. afterKeepId **只在下一次修剪前有效**（保留段會重新編號），連續修剪請每一步重新呼叫 list_seams。
6. 每次動手後用一兩句話總結改了什麼（幾筆、剪掉幾秒）；不確定就先問。
7. 回覆用繁體中文、精簡；時間用 mm:ss。`;

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
      const sys = lang ? `${SYSTEM_PROMPT}\n${lang}` : SYSTEM_PROMPT;
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
