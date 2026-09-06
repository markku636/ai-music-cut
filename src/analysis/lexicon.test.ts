import { afterEach, describe, expect, it } from "vitest";
import { customFillerPhrases, fillerRuleFor, isAnyFiller, isBuiltinFiller, isPureFiller, setFillerRules } from "./lexicon";

afterEach(() => setFillerRules({}));

describe("使用者詞表疊在內建詞表上", () => {
  it("沒設定時就是內建行為", () => {
    setFillerRules({});
    expect(isPureFiller("嗯")).toBe(true);
    expect(isAnyFiller("然後")).toBe(true);
    expect(isAnyFiller("蘋果")).toBe(false);
    expect(fillerRuleFor("然後")).toBeNull();
  });

  it("never 能把內建的詞關掉", () => {
    setFillerRules({ 然後: "never", 嗯: "never" });
    expect(isAnyFiller("然後")).toBe(false);
    expect(isPureFiller("嗯")).toBe(false); // 內建是純語助詞，使用者說別剪就別剪
  });

  it("always 能把新詞升成純贅字", () => {
    setFillerRules({ 蛤: "always" });
    expect(isPureFiller("蛤")).toBe(true);
    expect(isAnyFiller("蛤")).toBe(true);
  });

  it("context 算贅字但不算純贅字", () => {
    setFillerRules({ 我跟你講: "context" });
    expect(isAnyFiller("我跟你講")).toBe(true);
    expect(isPureFiller("我跟你講")).toBe(false);
  });

  it("輸入會做正規化（大小寫 / 標點 / 全形）", () => {
    setFillerRules({ "You Know,": "always" });
    expect(fillerRuleFor("youknow")).toBe("always");
  });

  it("忽略不合法的模式與空白詞", () => {
    setFillerRules({ 蛤: "sometimes", "  ": "always", "，": "never" });
    expect(fillerRuleFor("蛤")).toBeNull();
    expect(customFillerPhrases()).toEqual([]);
  });

  it("多字詞收進 phrases，長的排前面；單字不收", () => {
    setFillerRules({ 蛤: "always", 你知道: "context", 我跟你講: "always" });
    expect(customFillerPhrases()).toEqual(["我跟你講", "你知道"]);
  });

  it("isBuiltinFiller 認得內建詞、不認得自訂詞", () => {
    setFillerRules({ 蛤: "always" });
    expect(isBuiltinFiller("然後")).toBe(true);
    expect(isBuiltinFiller("嗯")).toBe(true);
    expect(isBuiltinFiller("蛤")).toBe(false); // 自訂的不算內建，UI 才分得出誰是誰
  });

  it("重設會清乾淨，不會殘留上一次的詞", () => {
    setFillerRules({ 蛤: "always" });
    setFillerRules({});
    expect(fillerRuleFor("蛤")).toBeNull();
    expect(customFillerPhrases()).toEqual([]);
  });
});
