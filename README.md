# AI Music Cut

AI Podcast / 音訊粗剪桌面工具（Tauri 2 + React 18），也有 CLI。丟進一段錄音，它會：

1. **剪贅字與口吃**：嗯／呃／那個／就是／我我我……以及講到一半重講的片段，但**以自然順暢為最高原則**——句首的「然後」、有節奏感的語助詞會保留，不是全剪。規則層先提候選，Claude 再逐段判讀自然度。
2. **音量平衡**：逐段 BS.1770 量測 → 增益規劃（±12 dB、峰值守門、平滑）→ EBU R128 loudnorm 兩趟，成品落在目標響度（預設 −16 LUFS）。
3. **含糊 / 離題 / 「再來一次」段落給建議**：偵測到但不自動剪，列成建議讓你逐一接受或拒絕。
4. **人也能剪，不只 AI**：開檔就有波形（不必先分析），「選取」工具拖一段就能播放（可循環）、剪掉、只保留、靜音、淡入淡出、增益；候選色塊可拉邊界、雙擊剪 ↔ 不剪；逐字稿 Shift+點選範圍、雙擊字直接剪。Wave Editor 式右鍵選單。
5. **去人聲 / 分軌**：一鍵把人聲與伴奏（或 4 軌）分開，伴奏軌就是去人聲版本，可以接著剪。
6. **ASR 驗收（人機協作的最後一關）**：輸出後把成品送回 ttls 重新轉寫，逐字比對「EDL 說該留的字」，標出漏字、該剪沒剪、可疑接縫；點一下就能聽那個位置或直接跳去修。
7. **AI 助手（Claude Code 式工具迴圈）**：本機 `claude` CLI 透過 App 內建的 MCP server 直接操作剪輯決策——「把 10 分鐘後的『就是』都剪掉，但句首的留著」。

語音辨識與人聲分離由自架的 [ttls](https://ttls.markkulab.net/)（Seal-TTS REST；`/v1/transcribe` = faster-whisper large-v3 逐字時間戳、`/v1/separate` = demucs htdemucs）提供。

![screenshot](docs/screenshot.png)

## 需求

- Windows 10/11（macOS / Linux 可自行建置，見 `.github/workflows/release.yml`）
- [ffmpeg 7+](https://ffmpeg.org/)（在 PATH，或在設定指定路徑）
- ttls API key（設定 → 伺服器；**只存 OS 鑰匙圈，不進任何檔案**）——沒有金鑰也能看波形、手動剪、輸出
- 選用：[Claude Code](https://claude.com/claude-code) CLI 已登入（AI 判讀 / AI 助手；預設模型 sonnet，可在設定改）

## 使用

畫面最上方的流程列會告訴你現在在哪一步、下一步按什麼：**① 開啟音檔 → ② 分析 → ③ 檢視決策 → ④ 輸出**。

1. 開啟音檔（或拖進視窗）→ 幾秒內看到整段波形、時間尺；已可播放、縮放（Ctrl+滾輪 / `Ctrl+=` `-` `0`）。
2. **手動剪**（隨時可做）：按 `S` 切到「選取」工具，在波形上拖一段 → 右下動作列或右鍵：播放（Space，可循環）、剪掉（Delete）、只保留、靜音、淡入 / 淡出、增益、縮放到選取（Z）。`V` 回到「定位」。
3. **分析**：轉檔上傳 ttls 轉寫、規則層提候選（贅字 / 口吃 / 長停頓 / 含糊 / 雜音）。缺金鑰時會直接帶你到設定欄位，不會白白上傳。
4. 看決策面板：綠勾接受、叉拒絕；滑桿調激進度即時重算；`[` `]` 上下一筆、`A` / `R`、`P` 預聽；波形上拖色塊邊緣調整範圍、雙擊切換。
5. **AI 判讀**：Claude 逐段審核候選（apply / suggest / drop），新增含糊 / 離題建議。
6. **AI 助手**：用自然語言指揮（會顯示每個工具呼叫）。
7. **輸出**：選格式 / 目標響度 / 是否逐段平衡 → mp3 / m4a / wav。效果（靜音 / 淡入淡出 / 增益）一併套用。
7b. **ASR 驗收**：輸出完成後按「用 ASR 驗收」（或流程列第 ④ 步），成品會被重新轉寫並逐字比對；報告列出漏字 / 該剪沒剪 / 可疑接縫，每筆都能「聽」或「去修」。
8. **去人聲**：工具列「去人聲」→ 選 2 軌或 4 軌 → 各軌寫在來源旁邊並加入媒體清單。

專案存成 `*.aicut.json`（含逐字稿、候選、決策、效果、AI 判讀快取）；同一個音檔重開會沿用快取，不重跑 ASR。`F1` 看完整快捷鍵。

> 中文輸入法開著時字母快捷鍵會被輸入法接走，切到英數模式即可；所有動作也都有按鈕與右鍵。

## CLI

```bash
npm run cli:build                                   # 打包成 dist-cli/aicut.mjs（單檔，Node 20+）
node dist-cli/aicut.mjs transcribe ep12.m4a         # 逐字稿（--json out.json 存原始 JSON）
node dist-cli/aicut.mjs analyze ep12.m4a --judge --project ep12.aicut.json   # 規則 + AI 判讀，存成專案給 App 微調
node dist-cli/aicut.mjs cut ep12.m4a --judge -o ep12_cut.mp3               # 一路到輸出
node dist-cli/aicut.mjs cut --project ep12.aicut.json                      # 沿用 App 存的決策 / 手動剪輯 / 效果
node dist-cli/aicut.mjs separate song.mp3 --format wav                     # 去人聲：song_vocals.wav / song_accompaniment.wav
node dist-cli/aicut.mjs verify ep12.m4a ep12_cut.mp3                       # ASR 驗收（有漏字 / 該剪沒剪 → exit code 2，可接 CI）
```

金鑰：`--key`、環境變數 `AICUT_TTLS_API_KEY`、或專案根目錄 `.env.local`；不會印出、不寫進任何輸出。CLI 只做全域 loudnorm（沒有 App 的逐段平衡）。

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
