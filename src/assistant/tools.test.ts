// MCP 工具目錄的契約。
//
// `tools.ts` 有 1188 行、四十幾支工具，而且**完全沒有測試**。handler 要測得先把整個
// store 層搬進來，成本很高；但真正常出事的不是 handler 邏輯，是**目錄本身**：
//
// - 兩支工具同名 → Rust 端用名字查表，後面那支永遠叫不到
// - schema 少了 `type: "object"` 或 `required` 指到不存在的欄位 → claude 產不出合法呼叫，
//   而且失敗訊息只會說「參數錯誤」，看不出是我們的 schema 寫壞了
// - 描述空白或太短 → 模型選錯工具（描述就是它唯一的選擇依據）
//
// 這些都是靜態可驗的，而且一支新工具加進來就會被檢查到。
import { describe, expect, it } from "vitest";
import { TOOLS } from "./tools";

interface Schema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

describe("MCP 工具目錄", () => {
  it("至少有四十支（漏了整批註冊會被抓到）", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(40);
  });

  it("**名字唯一**（同名的話後面那支永遠叫不到）", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size, `重複：${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`).toBe(names.length);
  });

  it("名字符合 MCP 慣例（小寫底線，不要空白或標點）", () => {
    for (const t of TOOLS) expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("每一支都有夠長的描述 —— 那是模型選工具唯一的依據", () => {
    for (const t of TOOLS) {
      expect(t.description.trim().length, `${t.name} 的描述太短`).toBeGreaterThan(20);
    }
  });

  it("每一支都有 handler", () => {
    for (const t of TOOLS) expect(typeof t.handler, t.name).toBe("function");
  });

  it("inputSchema 一律是 object schema 且不收多餘欄位", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as Schema;
      expect(s.type, `${t.name}.type`).toBe("object");
      // 收多餘欄位的話，模型拼錯欄名不會報錯，只會靜靜地當預設值跑
      expect(s.additionalProperties, `${t.name}.additionalProperties`).toBe(false);
    }
  });

  it("**required 裡的欄位一定要出現在 properties**（指到不存在的欄位模型永遠填不對）", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as Schema;
      for (const r of s.required ?? []) {
        expect(Object.keys(s.properties ?? {}), `${t.name} required "${r}"`).toContain(r);
      }
    }
  });

  it("每個參數都有型別（沒有型別的參數模型只能亂猜）", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as Schema;
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const prop = v as { type?: unknown; enum?: unknown[] };
        const ok = prop.type !== undefined || Array.isArray(prop.enum);
        expect(ok, `${t.name}.${k} 沒有 type 也沒有 enum`).toBe(true);
      }
    }
  });

  it("enum 不是空的", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as Schema;
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const e = (v as { enum?: unknown[] }).enum;
        if (e) expect(e.length, `${t.name}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it("陣列型參數要說明元素長什麼樣（沒有 items 模型會塞出各種東西）", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as Schema;
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const prop = v as { type?: unknown; items?: unknown };
        if (prop.type === "array") expect(prop.items, `${t.name}.${k} 缺 items`).toBeDefined();
      }
    }
  });

  it("沒有參數的工具也要有 properties（空物件），不要留 undefined", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as Schema;
      expect(s.properties, `${t.name}.properties`).toBeDefined();
    }
  });

  it("整份 schema 可以序列化成 JSON（要透過 JSON-RPC 送出去）", () => {
    for (const t of TOOLS) {
      expect(() => JSON.stringify(t.inputSchema), t.name).not.toThrow();
    }
  });

  it("今天新增的講者 / 字幕 / 分割工具都在目錄裡", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const n of ["list_speakers", "assign_speaker", "rename_speaker", "cut_fillers_by_speaker", "export_captions", "list_split_parts"]) {
      expect(names.has(n), n).toBe(true);
    }
  });
});
