import { errKind, errStatus } from "../api";

export interface BackoffOpts {
  delaysMs?: number[];
  /** 回 true 才重試。 */
  retryOn?: (e: unknown) => boolean;
  /** 每次重試前呼叫（顯示 toast / 更新工作列）。 */
  onRetry?: (attempt: number, delayMs: number, e: unknown) => void;
  /** 取消訊號：拋出時中止等待。 */
  signal?: AbortSignal;
}

export const DEFAULT_DELAYS = [5000, 10000, 20000, 40000, 60000, 60000];

/** ttls 忙碌（503 / 429）或連線層錯誤才重試；401/403（金鑰）與 4xx 不重試。 */
export function isTransientTtlsError(e: unknown): boolean {
  const kind = errKind(e);
  const status = errStatus(e);
  if (kind === "auth") return false;
  if (kind === "ttls") return status === 503 || status === 429 || status === 0 || status === 502 || status === 504;
  if (kind === "timeout") return true;
  return false;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOpts = {}): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS;
  const retryOn = opts.retryOn ?? isTransientTtlsError;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delays.length || !retryOn(e)) throw e;
      const d = delays[attempt];
      attempt += 1;
      opts.onRetry?.(attempt, d, e);
      await sleep(d, opts.signal);
    }
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}
