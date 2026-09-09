import { describe, expect, it } from "vitest";
import { micErrorKind } from "./micError";

/** DOMException 在 node 環境不一定有，用同形狀的物件（我們只看 name）。 */
const err = (name: string) => ({ name, message: "boom" });

describe("micErrorKind", () => {
  it("認得 W3C 定義的那幾個名字", () => {
    expect(micErrorKind(err("NotAllowedError"))).toBe("denied");
    expect(micErrorKind(err("SecurityError"))).toBe("denied");
    expect(micErrorKind(err("NotFoundError"))).toBe("notFound");
    expect(micErrorKind(err("OverconstrainedError"))).toBe("notFound");
    expect(micErrorKind(err("NotReadableError"))).toBe("busy");
    expect(micErrorKind(err("AbortError"))).toBe("busy");
    expect(micErrorKind(err("TypeError"))).toBe("unsupported");
  });

  it("認不出來的就是 unknown（不要硬猜）", () => {
    expect(micErrorKind(err("SomeFutureError"))).toBe("unknown");
    expect(micErrorKind(new Error("plain"))).toBe("unknown");
    expect(micErrorKind(null)).toBe("unknown");
    expect(micErrorKind("字串")).toBe("unknown");
    expect(micErrorKind(undefined)).toBe("unknown");
  });
});
