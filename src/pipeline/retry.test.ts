import { describe, expect, it } from "vitest";
import { isTransientTtlsError, withBackoff } from "./retry";

const ttls = (status: number) => ({ kind: "ttls", code: "ERR_TTLS", message: "x", status });

describe("retry", () => {
  it("classifies transient errors", () => {
    expect(isTransientTtlsError(ttls(503))).toBe(true);
    expect(isTransientTtlsError(ttls(429))).toBe(true);
    expect(isTransientTtlsError(ttls(0))).toBe(true);
    expect(isTransientTtlsError(ttls(422))).toBe(false);
    expect(isTransientTtlsError({ kind: "auth", code: "ERR_AUTH", message: "x", status: 401 })).toBe(false);
    expect(isTransientTtlsError(new Error("boom"))).toBe(false);
  });

  it("retries transient then succeeds", async () => {
    let n = 0;
    const calls: number[] = [];
    const r = await withBackoff(
      async () => {
        n += 1;
        if (n < 3) throw ttls(503);
        return "ok";
      },
      { delaysMs: [1, 1, 1], onRetry: (a) => calls.push(a) },
    );
    expect(r).toBe("ok");
    expect(calls).toEqual([1, 2]);
  });

  it("gives up on non-transient and after budget", async () => {
    await expect(withBackoff(async () => Promise.reject(ttls(401)), { delaysMs: [1] })).rejects.toMatchObject({ status: 401 });
    let n = 0;
    await expect(
      withBackoff(
        async () => {
          n += 1;
          throw ttls(503);
        },
        { delaysMs: [1, 1] },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(n).toBe(3);
  });

  it("aborts while sleeping", async () => {
    const ac = new AbortController();
    const p = withBackoff(async () => Promise.reject(ttls(503)), { delaysMs: [10_000], signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toHaveProperty("name", "AbortError");
  });
});
