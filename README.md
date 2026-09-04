# AI Music Cut

AI Podcast 自動粗剪桌面工具（Tauri 2 + React）。丟進一集錄音，它會：

1. **剪贅字與口吃**：嗯／呃／那個／就是／我我我……以及講到一半重講的片段，但**以自然順暢為最高原則**——句首的「然後」、有節奏感的語助詞會保留，不是全剪。
2. **音量平衡**：逐段 LUFS 增益 + EBU R128 loudnorm 兩趟，成品落在目標響度（預設 −16 LUFS）。
3. **含糊 / 離題 / 「再來一次」段落給建議**：偵測到但不自動剪，列成建議讓你逐一接受或拒絕。
4. **AI 助手（Claude Code 式工具迴圈）**：本機 `claude` CLI 透過內建 MCP server 直接操作剪輯決策——「把 10 分鐘後的『就是』都剪掉，但句首的留著」。

語音辨識由自架的 [ttls](https://ttls.markkulab.net/)（Seal-TTS REST；`/v1/transcribe` = faster-whisper 逐字時間戳）提供。

## 需求

- Windows 10/11（macOS / Linux 可自行建置）
- [ffmpeg 7+](https://ffmpeg.org/)（在 PATH，或在設定指定路徑）
- ttls API key（設定 → 伺服器；**只存 OS 鑰匙圈，不進任何檔案**）
- 選用：[Claude Code](https://claude.com/claude-code) CLI 已登入（AI 判讀 / AI 助手）

## 開發

```bash
npm install --legacy-peer-deps
npm run tauri dev        # 前端 1420 + Rust；首次 Rust 編譯 5–10 分鐘
npm run check            # tsc + eslint + vitest + 祕密掃描
cd src-tauri && cargo test
```

dev 便利：複製 `.env.example` 為 `.env.local`（gitignored）填 `AICUT_TTLS_API_KEY`；只有 debug build 且鑰匙圈為空時才會用到。

## 架構

見 [docs/architecture.md](docs/architecture.md)。殼層 / UI 原語 / 主題 / Claude CLI 橋接移植自 [db-kit](https://github.com/markku636/db-kit)。

## 授權

MIT
