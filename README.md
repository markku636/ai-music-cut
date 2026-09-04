# AI Music Cut

AI Podcast 自動粗剪桌面工具（Tauri 2 + React 18）。丟進一集錄音，它會：

1. **剪贅字與口吃**：嗯／呃／那個／就是／我我我……以及講到一半重講的片段，但**以自然順暢為最高原則**——句首的「然後」、有節奏感的語助詞會保留，不是全剪。規則層先提候選，Claude 再逐段判讀自然度。
2. **音量平衡**：逐段 BS.1770 量測 → 增益規劃（±12 dB、峰值守門、平滑）→ EBU R128 loudnorm 兩趟，成品落在目標響度（預設 −16 LUFS）。
3. **含糊 / 離題 / 「再來一次」段落給建議**：偵測到但不自動剪，列成建議讓你逐一接受或拒絕（逐字稿雙擊字也能直接剪 / 還原）。
4. **AI 助手（Claude Code 式工具迴圈）**：本機 `claude` CLI 透過 App 內建的 MCP server 直接操作剪輯決策——「把 10 分鐘後的『就是』都剪掉，但句首的留著」。

語音辨識由自架的 [ttls](https://ttls.markkulab.net/)（Seal-TTS REST；`/v1/transcribe` = faster-whisper large-v3 逐字時間戳）提供。

![screenshot](docs/screenshot.png)

## 需求

- Windows 10/11（macOS / Linux 可自行建置，見 `.github/workflows/release.yml`）
- [ffmpeg 7+](https://ffmpeg.org/)（在 PATH，或在設定指定路徑）
- ttls API key（設定 → 伺服器；**只存 OS 鑰匙圈，不進任何檔案**）
- 選用：[Claude Code](https://claude.com/claude-code) CLI 已登入（AI 判讀 / AI 助手；預設模型 sonnet，可在設定改）

## 使用

1. 開啟音檔（或拖進視窗）→ **分析**：轉檔上傳 ttls 轉寫（202+輪詢）、本機算波形與響度、規則層提候選。
2. 看決策面板：綠勾接受、叉拒絕；滑桿調激進度即時重算；`[` `]` 上下一筆、`A` / `R`、`P` 預聽。
3. **AI 判讀**：Claude 逐段審核候選（apply / suggest / drop），新增含糊 / 離題建議。
4. **AI 助手**：用自然語言指揮（會顯示每個工具呼叫）。
5. **輸出**：選格式 / 目標響度 / 是否逐段平衡 → mp3 / m4a / wav。

專案存成 `*.aicut.json`（含逐字稿、候選、決策、AI 判讀快取）；同一個音檔重開會沿用快取，不重跑 ASR。

## 開發

```bash
npm install --legacy-peer-deps
npm run tauri dev        # 前端 1420 + Rust；首次 Rust 編譯 5–10 分鐘
npm run check            # tsc + eslint + vitest + 祕密掃描
cd src-tauri && cargo test --no-default-features
```

dev 便利：複製 `.env.example` 為 `.env.local`（gitignored）填 `AICUT_TTLS_API_KEY`；只有 debug build 且鑰匙圈為空時才會用到。煙霧測試鉤子：`AICUT_DEV_OPEN=<音檔> AICUT_DEV_ANALYZE=1 AICUT_DEV_RENDER=1 npm run tauri dev`。

## 架構

見 [docs/architecture.md](docs/architecture.md)。殼層 / UI 原語 / 主題 / Claude CLI 橋接移植自 [db-kit](https://github.com/markku636/db-kit)。

## 授權

MIT
