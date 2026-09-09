// 極簡 CDP client（Node 22+ 內建 WebSocket）。
//
// 量測腳本都靠它跟**跑起來的 App** 對話：常數對不對只有真資料答得出來，
// 而真資料在 App 裡（逐字稿、EDL、播放器）。
//
// 用法見同目錄的 README.md。
export async function connect(port = 9222) {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    throw new Error(`連不上 127.0.0.1:${port}。App 要用 --remote-debugging-port 啟動，見 scripts/measure/README.md`);
  }
  const page = list.find((p) => p.type === "page" && /1420|localhost|tauri/.test(p.url));
  if (!page) throw new Error("找不到 App 的分頁（有其他 Chrome 佔用同一個 port 嗎？）");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  const send = (method, params) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  /**
   * 在頁面裡跑一段 JS 並拿回結果。
   *
   * `userGesture` 一定要帶：不帶的話會被自動播放政策擋掉，
   * 而症狀是「播放相關的量測全部回 0」，看起來像功能壞了。
   */
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };
  return { send, ev, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等 App 準備好：只有一份 React 樹、而且第一個媒體到了指定狀態。
 *
 * **`#root` 只能有一個子節點**：熱更新會把整棵 App 疊第二份上去
 * （`createRoot` 對同一個容器重跑），那時候量 DOM 會拿到兩份混在一起的答案。
 */
export async function waitReady(c, { analysis = false, timeoutMs = 240_000 } = {}) {
  const t0 = Date.now();
  let roots = -1;
  while (Date.now() - t0 < timeoutMs) {
    roots = await c.ev(`document.getElementById('root')?.children.length ?? -1`);
    if (roots >= 1) break;
    await sleep(1000);
  }
  if (roots !== 1) throw new Error(`#root 有 ${roots} 個子節點（要剛好 1 個）—— 熱更新疊了第二份 App，量出來不算數`);
  while (Date.now() - t0 < timeoutMs) {
    const st = await c.ev(`(() => {
      const m = __aicut.project.getState().media[0];
      if (!m) return null;
      return { id: m.id, analysis: m.analysis };
    })()`);
    if (st && (!analysis || st.analysis === "ready")) return st.id;
    await sleep(2000);
  }
  throw new Error(analysis ? "等不到分析完成（有裝 faster-whisper 嗎？）" : "等不到 App 開檔");
}

/** 百分位統計（給分佈用）。 */
export function stat(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p10: q(0.1), median: q(0.5), p75: q(0.75), p90: q(0.9), max: s[s.length - 1] };
}
