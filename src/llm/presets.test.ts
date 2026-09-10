import { describe, it, expect } from "vitest";
import { endpointOf, isApiBackendId, LLM_PRESETS, normalizeBase, presetsFor } from "./presets";
import { allSkills, BUILTIN_SKILLS, composeSystemPrompt, parseCustomSkills, serializeSkill, activeSkills } from "../assistant/skills";
import type { AppSettings } from "../api";

// normalize_base 的案例與 Rust 端（src-tauri/src/llm/mod.rs 的 normalize_base_cases）刻意寫成同一組：
// 兩邊算出來的網址不一樣的話，設定畫面顯示的「實際會打」就是騙人的。
describe("Base URL 正規化", () => {
  it("沒有 path 才補 /v1，自帶 path 原樣不動", () => {
    expect(normalizeBase("https://api.openai.com")).toBe("https://api.openai.com/v1");
    expect(normalizeBase("https://api.openai.com/")).toBe("https://api.openai.com/v1");
    expect(normalizeBase("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalizeBase("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeBase("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeBase("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeBase("https://open.bigmodel.cn/api/paas/v4")).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(normalizeBase("https://api.moonshot.cn/anthropic")).toBe("https://api.moonshot.cn/anthropic");
    expect(normalizeBase("  https://api.anthropic.com  ")).toBe("https://api.anthropic.com/v1");
    expect(normalizeBase("")).toBe("");
  });

  it("端點路徑依協定家族而不同", () => {
    expect(endpointOf("anthropic-api", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
    expect(endpointOf("openai-api", "http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(endpointOf("openai-api", "")).toBe("");
  });
});

describe("預設服務清單", () => {
  it("只列出屬於該後端的項目，http 的一律標成地端", () => {
    expect(presetsFor("anthropic-api").every((p) => p.backend === "anthropic-api")).toBe(true);
    expect(presetsFor("openai-api").some((p) => p.id === "ollama")).toBe(true);
    for (const p of LLM_PRESETS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      if (p.baseUrl.startsWith("http://")) expect(p.local).toBe(true);
    }
  });

  it("後端 id 判定", () => {
    expect(isApiBackendId("openai-api")).toBe(true);
    expect(isApiBackendId("anthropic-api")).toBe(true);
    expect(isApiBackendId("claude")).toBe(false);
    expect(isApiBackendId("codex")).toBe(false);
  });
});

function settings(patch: Partial<AppSettings>): AppSettings {
  return { assistant_skills: [], assistant_skills_on: [], ...patch } as AppSettings;
}

describe("助手技能", () => {
  it("內建在前、自訂在後；壞掉的自訂資料被濾掉而不是整份炸掉", () => {
    const custom = serializeSkill({ id: "skill:1", name: "我的", body: "內容" });
    const s = settings({ assistant_skills: [custom, "{壞掉的 JSON", JSON.stringify({ id: 1 })] });
    const all = allSkills(s);
    expect(all).toHaveLength(BUILTIN_SKILLS.length + 1);
    expect(all[all.length - 1].name).toBe("我的");
    expect(parseCustomSkills(undefined)).toEqual([]);
  });

  it("只有勾選中的會被組進系統提示詞", () => {
    const s = settings({ assistant_skills_on: [BUILTIN_SKILLS[0].id] });
    const active = activeSkills(s);
    expect(active).toHaveLength(1);
    const sys = composeSystemPrompt("你是助手", active);
    expect(sys.startsWith("你是助手")).toBe(true);
    expect(sys).toContain(BUILTIN_SKILLS[0].name);
    expect(sys).toContain(BUILTIN_SKILLS[0].body);
  });

  it("沒勾任何技能時，系統提示詞就是原本的人設", () => {
    expect(composeSystemPrompt("你是助手", [])).toBe("你是助手");
  });

  it("內容空白的技能不佔位（新增後還沒寫內容）", () => {
    expect(composeSystemPrompt("人設", [{ id: "s", name: "空的", body: "  " }])).toBe("人設");
  });
});
