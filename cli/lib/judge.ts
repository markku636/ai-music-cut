// AI 判讀（CLI 版）：與 App 相同的視窗 / prompt / schema / 驗證，只是改用 child_process 跑本機 claude CLI。
import { spawn } from "node:child_process";
import { JUDGE_SYSTEM_PROMPT, renderWindow } from "../../src/analysis/llm/prompt";
import { JUDGE_SCHEMA } from "../../src/analysis/llm/schema";
import { validateJudge, type ValidatedJudge } from "../../src/analysis/llm/validate";
import { makeWindows } from "../../src/analysis/llm/windows";
import type { Candidate, DecisionMap, Transcript } from "../../src/analysis/types";

const IS_WIN = process.platform === "win32";

/** claude -p --output-format json --json-schema …（零工具、限 3 回合），回 structured_output。 */
export function claudeStructured(prompt: string, schema: unknown, model: string, system: string, timeoutMs = 240_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--permission-mode", "dontAsk", "--max-turns", "3", "--append-system-prompt", system, "--model", model];
    const p = spawn(IS_WIN ? "claude.cmd" : "claude", args, { windowsHide: true, shell: IS_WIN, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`claude 逾時（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`找不到 claude CLI：${e.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).reverse();
      let v: Record<string, unknown> | null = null;
      for (const l of lines) {
        try {
          v = JSON.parse(l.trim()) as Record<string, unknown>;
          break;
        } catch {
          /* 非 JSON 行 */
        }
      }
      if (!v) {
        reject(new Error(code === 0 ? `claude 回應不是 JSON：${out.slice(0, 200)}` : err.trim() || `claude 結束碼 ${code}`));
        return;
      }
      if (v.is_error === true) {
        reject(new Error(String(v.result ?? "claude 回報錯誤")));
        return;
      }
      if (v.structured_output != null) {
        resolve(v.structured_output);
        return;
      }
      try {
        resolve(JSON.parse(String(v.result ?? "")));
      } catch {
        reject(new Error("claude 沒有回 structured_output"));
      }
    });
    p.stdin.end(prompt);
  });
}

export interface JudgeResult {
  updates: ValidatedJudge["updates"];
  added: Candidate[];
  windows: number;
  failed: number;
  warnings: string[];
}

/** 對規則候選跑 AI 判讀（並行 2 個視窗）。 */
export async function judgeAll(tr: Transcript, candidates: Candidate[], decisions: DecisionMap, model: string, onProgress?: (done: number, total: number) => void): Promise<JudgeResult> {
  const windows = makeWindows(tr, candidates);
  const total = windows.length;
  const res: JudgeResult = { updates: [], added: [], windows: total, failed: 0, warnings: [] };
  let done = 0;
  const worker = async () => {
    for (;;) {
      const w = windows.shift();
      if (!w) return;
      const r = renderWindow(tr, w, candidates, decisions);
      try {
        let raw = await claudeStructured(r.prompt, JUDGE_SCHEMA, model, JUDGE_SYSTEM_PROMPT);
        let v = validateJudge(raw, w, r.alias, tr, candidates);
        if (v.warnings.includes("輸出不符 schema")) {
          raw = await claudeStructured(`${r.prompt}\n\n（上次輸出不符 schema，請只輸出符合 schema 的 JSON）`, JUDGE_SCHEMA, model, JUDGE_SYSTEM_PROMPT);
          v = validateJudge(raw, w, r.alias, tr, candidates);
        }
        res.updates.push(...v.updates);
        res.added.push(...v.added);
        res.warnings.push(...v.warnings.map((x) => `${w.id}: ${x}`));
      } catch (e) {
        res.failed += 1;
        res.warnings.push(`${w.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      done += 1;
      onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, total) }, worker));
  return res;
}
