# 架構

```
┌─ ai-music-cut (Tauri 2 desktop) ─────────────────────────────────────────────┐
│ React 18 + zustand（無 router）                                                │
│   shell/   Toolbar · Sidebar(媒體+工作) · MainArea · StatusBar                  │
│   timeline/ wavesurfer 7 + Regions（peaks 由 Rust 預算，不在 WebView 解碼）     │
│   transcript/ 字 chip（劃線=剪、虛框=待決、雙擊剪/還原）                        │
│   decisions/ 候選面板（篩選 / 批次 / 激進度 / 預聽）                             │
│   assistant/ Claude 聊天（工具呼叫列）+ tools.ts（MCP 工具目錄與 handler）        │
│   analysis/  純函式：normalize → rules → llm(judge) → edl → loudness           │
│   pipeline/  analyze / judge / render / rules / persist                       │
│ Rust（src-tauri）                                                              │
│   ffmpeg.rs 偵測+probe · media.rs 串流波形+ebur128 · render.rs 串流剪接+loudnorm │
│   ttls.rs REST client · agent.rs claude CLI 橋 · mcp.rs loopback MCP server    │
│   store.rs settings.json + OS keychain（API key 唯一落點）                      │
└──────────┬──────────────────────────────┬────────────────────────────────────┘
           │ HTTPS X-API-Key              │ spawn claude -p … --mcp-config
   ttls.markkulab.net (FastAPI)       claude CLI ──MCP──▶ 127.0.0.1:{port}/mcp
   /v1/transcribe/jobs（faster-whisper）  (judge: --json-schema 結構化輸出)
```

## 資料流

1. **分析**（`pipeline/analyze.ts`）：ffprobe → 指紋（blake3 size‖首尾 4 MiB）→ `upload.ogg`（16k opus）→ 並行 [本機 `analysis.bin`（5 ms 波形桶 + 100 ms LUFS 視窗）∥ ttls 轉寫 202+輪詢（503/429 backoff）] → `normalizeTranscript`（秒→ms、句子切分）→ `runRules` → 候選 + 預設決策。
2. **規則層**（`analysis/rules/*`）：贅字（語境：句首「然後」保留、「那個」+名詞保留、問句後的「對」是回答…）、口吃 / 重複片語 / restart（LCS）、長停頓縮短為 350 ms、含糊（低信心 / 段級訊號 / 音量偏小）、雜音。門檻由激進度 0–100 線性插值（`thresholds.ts`）。
3. **決策**（`store/decisions.ts`）：`auto | accepted | rejected | pending`；只建議的類型（unclear / rambling / off_topic / redo）永遠不會自動剪；user 決策跨重跑保留；undo/redo 為整份快照。
4. **AI 判讀**（`pipeline/judge.ts`）：候選句切視窗（前後 3 句語境）→ `claude -p --json-schema` → 驗證（代號→id、文字→字範圍）→ `applyJudge`。視窗雜湊快取進專案檔。
5. **AI 助手**（`assistant/`）：`claude -p --output-format stream-json --mcp-config … --allowedTools mcp__aicut --permission-mode dontAsk`；Rust 內建 MCP server 把 `tools/call` 轉成 `mcp-tool-call` 事件，前端 handler 操作 store 後以 `mcp_tool_result` 回寫。
6. **EDL**（`analysis/edl/build.ts`）：字邊界 pad → 貼低能量點 → 合併 → 單句剪除比守門 → 補集為保留段 → 呼吸回填 / room tone gap → src↔out 映射（剪後時鐘、跳播）。
7. **輸出**（`render.rs`）：保留段再依 VAD 切成 ≤15 s 單元 → BS.1770 閘門量測 → 增益規劃（clamp ±12 dB、峰值守門、平滑、階差 ≤3 dB）→ Rust 串流剪接（等功率 crossfade / seam / gap）→ `concat.wav` → ffmpeg loudnorm 兩趟 + alimiter → mp3 / m4a / wav。

## 祕密與隱私

- ttls API key：Settings → `ttls_key_set` → OS keychain（service `ai-music-cut`）。唯一讀取點 `ttls::api_key()`；沒有任何 command 回傳它；專案檔 / 設定檔 / log 不含金鑰（`format.test.ts` 與 `store.rs` 測試斷言）。
- claude 走使用者本機登入；MCP server 只綁 loopback、每次啟動隨機 bearer token，只給自家 claude 子程序。
- `scripts/check-secrets.mjs` 在 `npm run check` 掃 tracked files。

## 專案檔 `*.aicut.json`（schemaVersion 1）

`media[]`（路徑 / 指紋 / probe）、`settings`（激進度 / 目標響度）、`analysis[mediaId]`（`transcript`、`candidates`、`decisions`、`llm` 視窗快取）。媒體快取（opus / analysis.bin / transcript.json）在 `%LOCALAPPDATA%\net.markkulab.aimusiccut\media\<fp16>\`，同檔重開免重跑。

## dev 鉤子（只在 debug build 生效）

`AICUT_DEV_OPEN=<音檔>`、`AICUT_DEV_ANALYZE=1`、`AICUT_DEV_JUDGE=1`、`AICUT_DEV_RENDER=1`、`AICUT_DEV_ASK="…"`：啟動即自動開檔 / 分析 / 判讀 / 輸出 / 問助手，方便煙霧測試。前端錯誤透過 `client_log` 印到 `tauri dev` 終端。
