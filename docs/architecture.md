# 架構

```
┌─ ai-music-cut (Tauri 2 desktop) ─────────────────────────────────────────────┐
│ React 18 + zustand（無 router）                                                │
│   shell/   Toolbar · Sidebar(媒體+工作) · MainArea · StatusBar                  │
│   timeline/ wavesurfer 7.12.11 + Regions/Timeline/Hover（peaks 由 Rust 預算）    │
│             選取工具 / 候選拉邊界 / 效果 region / 右鍵選單 / SelectionBar         │
│   transcript/ 字 chip（劃線=剪、虛框=待決、雙擊剪/還原）                        │
│   decisions/ 候選面板（篩選 / 批次 / 激進度 / 預聽）                             │
│   assistant/ Claude 聊天（工具呼叫列）+ tools.ts（MCP 工具目錄與 handler）        │
│   analysis/  純函式：normalize → rules → llm(judge) → edl → loudness → effects │
│   pipeline/  waveform / analyze / judge / render / rules / persist / separate │
│   cli/       aicut（同一套 analysis，I/O 走 ffmpeg 子程序 + fetch + claude）     │
│ Rust（src-tauri）                                                              │
│   ffmpeg.rs 偵測+probe · media.rs 串流波形+ebur128 · render.rs 串流剪接+loudnorm │
│   ttls.rs REST client（transcribe / separate）· agent.rs claude CLI 橋 · mcp.rs  │
│   store.rs settings.json + OS keychain（API key 唯一落點）                      │
└──────────┬──────────────────────────────┬────────────────────────────────────┘
           │ HTTPS X-API-Key              │ spawn claude -p … --mcp-config
   ttls.markkulab.net (FastAPI)       claude CLI ──MCP──▶ 127.0.0.1:{port}/mcp
   /v1/transcribe/jobs（faster-whisper）  (judge: --json-schema 結構化輸出)
```

## 資料流

0. **開檔**（`pipeline/waveform.ts`）：ffprobe → 指紋 → 立刻跑本機 `analysis.bin`（5 ms 波形桶 + 100 ms LUFS 視窗；只需 ffmpeg、快取命中即時）→ 時間軸 fit-to-width 首繪。與 ttls / 金鑰無關；沒分析也能播放、手動剪、輸出。
1. **分析**（`pipeline/analyze.ts`）：確保本機分析 ∥ `upload.ogg`（16k opus）→ ttls 轉寫 202+輪詢（503/429 backoff）→ `normalizeTranscript`（秒→ms、句子切分）→ `runRules` → 候選 + 預設決策。
1b. **節拍**（`analysis/beats.ts`）：5 ms RMS 桶 → 半波整流一階差分（onset）→ 自相關（60–190 BPM，倍/半週期加權）→ 相位對齊 → 拍點 / 小節線；信心 < 0.12 視為非音樂不顯示。選取貼齊在 `store/timeline.setSelection` 統一處理（拖曳、逐字稿、右鍵都吃得到）。
2. **規則層**（`analysis/rules/*`）：贅字（語境：句首「然後」保留、「那個」+名詞保留、問句後的「對」是回答…）、口吃 / 重複片語 / restart（LCS）、長停頓縮短為 350 ms、含糊（低信心 / 段級訊號 / 音量偏小）、雜音。門檻由激進度 0–100 線性插值（`thresholds.ts`）。
3. **決策**（`store/decisions.ts`）：`auto | accepted | rejected | pending`；只建議的類型（unclear / rambling / off_topic / redo）永遠不會自動剪；user 決策與人工拉過的範圍（`meta.userRange`）跨重跑保留；undo/redo 為整份快照（候選 + 決策 + 效果）。
3b. **人工剪輯**（`store/timeline.ts` + `timeline/selectionActions.ts`）：選取工具拖出 `selection` → 剪掉（manual 候選）/ 只保留 / 播放（可循環）；區段效果（`analysis/effects.ts`：mute / gain / fade_in / fade_out）以來源時間包絡定義，預聽用 `<audio>.volume`，輸出由 Rust 逐 frame 相乘（同一套 5 ms 邊緣平滑）。
4. **AI 判讀**（`pipeline/judge.ts`）：候選句切視窗（前後 3 句語境）→ `claude -p --json-schema` → 驗證（代號→id、文字→字範圍）→ `applyJudge`。視窗雜湊快取進專案檔。
5. **AI 助手**（`assistant/`）：`claude -p --output-format stream-json --mcp-config … --allowedTools mcp__aicut --permission-mode dontAsk`；Rust 內建 MCP server 把 `tools/call` 轉成 `mcp-tool-call` 事件，前端 handler 操作 store 後以 `mcp_tool_result` 回寫。
5b. **刀片切點與修剪**（`analysis/edl/split.ts` / `trim.ts`、`timeline/trimActions.ts`）：
   切點 `SplitPoint {id, ms, gapMs?}` 存在 `store/decisions.splits[mediaId]`（一併進 `Patch` 快照 → undo 免費），
   進專案檔 `analysis[mediaId].splits`（選填，schemaVersion 維持 1）。`buildEdl` 步驟 6b 用切點把保留段斷開並**重新編號 keep.id**
   （joins / splitUnits / render 的 units 全靠這個編號對位），步驟 7 為切點產生 `kind:"seam"`（butt join）或 `kind:"gap"`（留白）。
   **切點一定要產生一個明確的 join** —— `pipeline/render.ts` 對「相鄰兩個 keep 但查不到 join」會退回預設 crossfade，
   而 crossfade 是重疊，會真的吃掉聲音。修剪走 `planTrim`（漣漪只動最外側候選、捲動整批平移）與
   `planSplitRipple`（切點上還沒有剪除區，只能開始往某一側吃）。

5c. **人放的邊界照著用**（`build.ts` 的 `Removal.userRange`）：
   手動剪除（`source === "user"`）與拖過邊界的候選（`meta.userRange`）**跳過** ±30 ms 能量最低點搜尋與呼吸回填 ——
   那兩段是為了讓 AI 提的候選落在安靜處，套在明確的拖曳上就變成跟使用者作對（拖 300 ms 卻剪掉 377 ms，
   捲動修剪還會因為兩邊各自重新貼齊而改變成品總長，而「總長不變」正是捲動修剪存在的意義）。
   ±3 ms 零交越微調仍然保留，擋切在波形中間的 click。合併時 `userRange` 取 or：人碰過的區域整段照人的意思走。

5d. **統一吸附**（`analysis/snap.ts`）：目標涵蓋接縫 / 句界 / 字界 / 播放線 / 頭尾，拍點用 `snapToBeat` 的公式算（週期性，不展開成陣列）。
   `store/timeline.setSelection` 仍是唯一吸附入口，拖接縫與 `B` 切刀也走同一支 `snapMs`。容差 = 8 px 換算成 ms（上限 140 ms）。
   目標由 `MainArea` 在 EDL / 逐字稿變動時攤平進 `snapTargets`；播放線每秒動 60 次，所以不進那份快取，算 context 時才附上去。

5e. **轉盤與精準修剪**（`preview/shuttle.ts` / `useShuttle.ts` / `PrecisionTrim.tsx`）：
   `nextShuttle` 是純狀態機，走一條 `[-4,-2,-1,0,1,2,4]` 的階梯，用「嚴格大於 / 小於目前值的第一格」
   前進（不是「找最近再 ±1」—— 慢速 0.5x 卡在 0 與 1 中間會平手，往哪邊解都有一邊錯）。
   順向直接設 `playbackRate`；**倒退沒有辦法出聲**（`<audio>` 不支援負的 playbackRate），
   改成暫停元素、用共用 ticker 每幀把 currentTime 往回推，UI 標「靜音」。
   精準修剪器用**位置**追接縫（`focusSeamMs`）而不是 `afterKeepId` —— keep 是推導出來的，
   剪除區一移開，原本被壓住的切點又會重新把保留段切開，編號整個往後移。

5f. **標記與章節**（`analysis/chapters.ts`、`decisions/IndexPanel.tsx`）：
   `Marker {id, ms, kind: standard|chapter|todo, title, note?, done?}` 一樣掛在 decisions store（進 Patch → undo）與專案檔。
   章節匯出有三個容易錯的地方，所以整理成一支純函式 `buildChapters`：
   ① 標記釘在**來源**時間，章節寫進的是**成品**，要用 `mapSrcToOut` 換算（剪愈多錯愈遠）；
   ② 標記落在剪掉的區間時挪到下一段保留段的開頭，而不是默默丟掉；
   ③ 章節必須連續不重疊、首章補到 0、末章補到成品結尾 —— 播放器對重疊章節的反應從忽略到整份 metadata 不讀都有。
   `toFfmetadata` 產生 ffmetadata 全文（跳脫 `=` `;` `#` `\` 與換行），Rust 只負責寫檔並多帶
   `-i meta -map 0:a -map_metadata 1`。**格式化刻意只有一份**：跳脫規則細，在 Rust 再寫一次
   就是第二個會出錯的地方，而且沒有對拍測試抓得到。

5g. **輸出一定要指定聲道佈局**（`render.rs` 的 `aformat=channel_layouts=mono|stereo`）：
   `concat.wav` 是 hound 寫的，沒有 channel mask，ffmpeg 讀進來是「1 channels (FL)」這種**未命名**佈局。
   pcm 與 mp3 不在意，但原生 aac 編碼器會直接回 -22 (Invalid argument) —— 症狀是 m4a 輸出一律失敗，
   而 ffmpeg 的最後一行只寫 "Conversion failed!"，看不出原因。（編碼失敗的訊息現在會保留最後四行。）

5h. **配樂 / 音效軌與自動閃避**（`analysis/overlays.ts` + `src-tauri/src/mix.rs`）：
   `Overlay {lane, mediaId, srcIn/srcOut, outStartMs, gainDb, fadeIn/Out, points[]}` 掛在 decisions store（undo）與專案檔。
   **位置釘在成品時間**，不是來源時間 —— 使用者是在剪好的節目上決定「開場音樂放這裡」，
   之後再多剪掉幾個贅字，音樂不該跟著往前跑。時間軸畫的時候用 `mapOutToSrc` 換回來源時間才對得上波形。
   成品長度是「主聲軌與所有配樂之中最晚結束的那一個」（`outputDurationWithOverlays`）——
   片尾曲會在最後一句話之後才播完，成品要蓋得住它，不然音樂會在講完的那一刻被硬切且不報錯。
   TS 與 Rust 兩邊都要算同一個長度，否則驗收會誤報「成品長度不對」。
   混音在 `run()` 裡插在 **cut 之後、measure 之前** —— loudnorm 要對的是使用者聽到的那一份（含配樂），
   先量主聲軌再加音樂的話成品會比目標響度大。

   自己寫混音而不用 ffmpeg 的 `filter_complex`：閃避曲線在 filter graph 裡只能用 `volume` 的運算式硬寫，
   一集節目幾十段閃避就是幾千字元的表達式（Windows 命令列會先撞牆），而且 filter 字串沒辦法寫測試。
   `mix.rs` 逐 frame 走成品時間軸，每一軌同時只會有一個片段在播，所以解碼管線是「用到才開、過了就關」，
   記憶體不隨素材長度成長。**注意**：解碼緩衝要用讀取游標，不能 `carry.drain(..frame_bytes)` 逐 frame 砍前面 ——
   那是每個 frame 一次 memmove，34 秒的素材就會慢到像當掉。
   修好之後實測：10.35 分鐘的節目 + 整段配樂 + 128 個閃避控制點，混音那一趟只多花 **1.2 秒**
   （不含混音 12.2 s、含混音 13.4 s），約 500 倍即時，40 分鐘的節目也只多幾秒。

   閃避（`planDuck`）刻意產生**控制點**而不是接壓縮器：壓縮器聽起來不對的時候只能轉 threshold / ratio 猜，
   剪輯師要的是「這一句底下再低 3 dB」—— 那是拖一個點的事。內插在 **dB 域**做，0 → −12 dB 才聽起來等速。

5i. **配樂即時試聽**（`preview/overlayMonitor.ts`）：每個片段一個自己的 `<audio>`，
   跟著主聲軌對時。三件事：① 主聲軌播的是**來源**時間（而且會跳過剪掉的段落），
   配樂的位置卻釘在**成品**時間，所以每一幀要 `mapSrcToOut` 換算；② 不能每幀都 seek
   （解碼器會重新定位而卡頓），偏移超過 90 ms 才校正；③ 這是監聽不是成品 ——
   兩個 `<audio>` 對不到樣本，成品的精準混音在 mix.rs 那一趟。
   **包絡公式在 TS 與 Rust 各一份**（`envelopeGain` / `overlay_gain`），
   兩邊用同一組數字寫測試釘住：不然「試聽覺得剛好」的閃避深度到成品會變成另一個值。
   只在「有配樂 ∧ 正在播」時訂閱 ticker —— ticker 沒有訂閱者才會停，長期掛著等於暫停時也在跑 rAF。

5j. **多麥克風同步**（`analysis/sync.ts` + `media.rs` 的 `combine_tracks`）：
   對齊比對的是**能量包絡**不是波形 —— 兩支麥的相位、音色、增益都不同，樣本層級的
   相關性很低，而且 40 分鐘 × 48 kHz 的互相關算不完；包絡把資料量降到 1/2400 還更穩。
   降到 20 Hz、挑能量最集中的 90 秒視窗、±120 秒內做正規化互相關。
   **信心用「最佳與次佳的差距」而不是相關係數本身**：講話的能量包絡到處都有點像，
   相關係數會一直很高，真正代表「對上了」的是有沒有一個明顯勝出的位移。
   對齊後**併成一軌**（不保留多軌）：EDL、跳播、驗收、輸出整條路徑都假設單一來源，
   要留多軌就得讓每一刀同步套用到每一軌，那是另一個層級的改動。合併寫出新檔，原檔不動。
   `adelay` 只能往後推，所以 `delaysFromOffsets` 先把整組平移到「最早那一軌 = 0」；
   `amix` 一定要帶 `normalize=0`，否則每一路會被除以路數，兩支麥就各小 6 dB。

5k. **串音衰減**（`analysis/gate.ts`）：一人一軌時每支麥都收得到別人講話，合起來
   同一句會聽到兩次（一次清楚、一次糊的）。處理方式是「沒在講話時把這一軌壓下去」，
   而**關鍵不在濾波器而在門檻設在哪** —— 每支麥的增益、距離、房間都不一樣，寫死一個
   dB 值一定有人被切掉氣音、有人完全沒作用。所以門檻由該軌自己的 5 ms RMS 桶做直方圖
   取百分位量出來（底噪 35%、人聲 95%），門檻放在兩者之間偏底噪那一側（mix = 0.35）：
   寧可讓一點串音漏過去，也不要切掉氣音與句尾 —— 被切掉的字救不回來。
   人聲與底噪差距 < 12 dB 的軌直接跳過（那種軌硬切會傷到內容）。
   衰減深度刻意不提供「完全靜音」：串音底下還有房間的空氣聲，切到 0 之後每次換人講話
   都會有一個空間感落差，比留一點串音更明顯。

5l. **分軌輸出**（`pipeline/stems.ts`）：先輸出完整混音拿到 `LoudnormStats`，再用**同一組**
   量測值輸出人聲軌（`overlays: []`）與配樂軌（`mute_main: true`）。每一軌各自 loudnorm 的話，
   配樂會被拉到跟人聲一樣大聲，各軌之間的相對音量就跟核可的混音對不上。
   **不會逐樣本相加等於完整混音** —— 真實峰值限制器逐檔套用，完整混音的峰值比任何單軌都高、
   被壓的量也不一樣（實測完整混音 mean −16.4 dB、兩軌相加 −14.5 dB）。這跟所有 DAW 的 stem
   匯出一樣：stem 是給人重新混音的素材，不是母帶的代數分解。UI 上明講，不要宣稱相加相等。

5m. **只輸出一段**（`analysis/clip.ts`）：把同一份剪輯計畫夾在選取範圍內輸出，
   不是另外開專案再剪一次。範圍是連續的，所以只有頭尾的響度單元會被切、中間不會有洞 ——
   接點（joins）因此可以原樣沿用。配樂要另外處理：它的位置是**成品**時間，
   所以先用 `mapSrcToOut` 把選取起點換算成成品時間當原點，再把片段往前挪；
   被切到頭的片段連**來源進點**一起移，否則音樂會從頭重播。
   章節與分軌只寫進完整成品（一段 60 秒的預告不需要章節，時間軸原點也不一樣）。

5n. **給 agent 用的工具要冪等**（`assistant/tools.ts`）：兩個實際跑地端 claude 才發現的問題。
   ① `get_project_summary` 原本沒有逐字稿就丟例外，而 MCP 的指示叫 claude **先呼叫它** ——
   一丟例外，claude 就以為什麼都不能做而放棄整個任務。現在沒分析也回得出東西（`analyzed: false`
   加一句說明），因為 App 本來就開檔即可剪。
   ② `blade_at` 原本是 toggle（同位置再切一次＝移除），那對鍵盤的 B 是對的，
   對工具是災難：agent 重試或連續呼叫是常態，實測 claude 來回切了三次、undo 歷史是
   「切一刀 / 移除切點」× 3，最後什麼都沒留下，而每次回傳看起來都成功。
   工具版改成冪等（已存在就當成功），要移除另給 `remove_blade`；鍵盤仍然 toggle。
   ③ 同一個道理再遇到一次：`cut_text` 被 claude 用同一個查詢呼叫了兩次，第二次什麼都沒改
   卻照樣 commit，undo 堆疊多了一筆空操作 —— 使用者按一次 Ctrl+Z 看起來完全沒反應。
   `addManualCuts` 現在只在真的有變動時才 commit（新增了候選，或有段落原本被拒絕、這次改回 accepted）。
   通則：**agent 會重試，所以每一個寫入工具都要能安全地重跑，而且「沒事可做」不等於「做了一件空事」。**

5o. **逐字稿文字搜尋**（`analysis/textSearch.ts`）：字已經帶 `Word.norm`（NFKC + 小寫 + 去標點空白），
   把它們接成一條字串再配一份「字元位置 → 字索引」對照表，就能用 indexOf 掃出**跨字也跨句**的命中 ——
   ASR 把「那個」拆成兩個 token、或把逗號黏在字尾，都不影響比對。三個踩得到的地方：
   ① 查詢正規化後可能是空字串（使用者只打了標點），而 `indexOf("")` 每個位置都命中 ——
   那會把整份逐字稿當成要剪的東西，所以空查詢一律回空陣列；
   ② 命中之間不重疊（「那那那」搜「那那」只算一個）—— 命中是要拿去剪的，重疊的區間會互相吃掉；
   ③ 口頭禪面板長詞優先，短詞要扣掉被長詞吃掉的那些，否則「那個那個 ×5」會讓「那個」看起來有 10 次，
   使用者按了短的反而剪掉更多。批次剪除走 `addManualCuts`，N 筆合成**一次 commit**（一次 undo 全還原）。

5p. **修聲**（`analysis/cleanup.ts` + `src-tauri/src/cleanup.rs`）：去隆隆（highpass 80 Hz）/ 降噪（afftdn）/ 齒音（deesser）。
   前端只送**數字**，濾鏡字串一律在 Rust 端組 —— 讓前端送 ffmpeg 濾鏡語法等於把任意濾鏡的執行權交出去；
   所有數值在組字串時再夾一次範圍。順序是 highpass → afftdn → deesser（先切掉低頻，降噪才不會把預算花在那裡）。
   **這條鏈必須同時進 `measure` 與 `encode` 兩趟**：loudnorm 走 `linear=true`，pass 1 量到的數字直接決定
   pass 2 要套多少增益；只在編碼那趟修聲的話，量的是沒修過的響度、套的是修過的訊號，成品會整體偏低，
   偏多少看素材，完全不可預期。實測 12 秒片段（同一組剪輯，只差修聲）：噪音底 −23.7 → −78.3 dB、
   RMS −16.59 → −16.83 dB、整合響度 −17.1 → −17.3 LUFS（差 0.2 LU，就是「有進量測那一趟」的證據）。
   降噪建議值由底噪推導（低於 −58 dBFS 不建議做、上限 18 dB），**齒音預設不開** ——
   這份分析只有能量包絡、沒有頻譜，沒有量測依據就不要替使用者決定。
   設定放 `store/cleanup.ts`（**不進 undo**：它是輸出設定，跟目標響度同一類，
   不該和「剪掉這一句」擠在同一條復原歷史上），存檔走 `pipeline/persist.ts`。
   `previewRender.ts` 的快取指紋要算進修聲，否則調完降噪按「剪後（成品）」會拿到上一份快取檔 ——
   而那正是使用者拿來判斷有沒有效的地方。

5q. **滑過就聽得到（skimming）**（`preview/skim.ts` + `skimPlayer.ts`）：Final Cut 的 audio skimming（Shift+S）。
   真正的磁帶式刮盤在瀏覽器裡做不到（`<audio>` 沒有反向播放，也不能跟著滑鼠速度即時重取樣），
   所以做法是**在游標位置丟一小段 grain**。難的是「什麼時候重播」，三個極端都會出事：
   每次 pointermove 都播 = 一秒幾十次的連續爆音；只用時間節流 = 游標停著也一直重播同一段；
   只用距離節流 = 慢慢拖過長檔案時每一格都觸發。所以兩個條件要**同時**成立：
   離上次夠久（90 ms）**而且**游標真的移動夠遠（60 ms）。決定與播放分成兩支，決定那支才測得出來。

   **grain 要用媒體時間收尾，不是牆上時間**。量出來的事實：`play()` 之後前 ~45 ms
   音訊裝置在暖機，`currentTime` 完全不動 —— 180 ms 的計時器只換到 140 ms 真正聽得到的內容
   （最早的版本更糟，計時從觸發那一刻算，只剩 ~93 ms）。改成到期時先看媒體走到哪、沒走完就補時之後，
   實測穩定在 180–184 ms。用自己的 `<audio>` 而不是共用主聲軌那顆：skim 是「偷聽一下」，
   不該改變任何狀態；主聲軌開始播的時候音源會被拔掉（兩個聲音疊在一起最難聽）。

5r. **精華合輯**（`analysis/reel.ts`）：把好幾段**不相鄰**的範圍串成一支預告。
   跟「只輸出這一段」（`clip.ts`）的差別不只是數量：連續範圍夾完之後，留下來的相鄰單元
   關係跟夾之前一樣，所以接點可以原樣沿用；不相鄰的範圍串起來，**每一個範圍交界都是新的接點**。
   所以 `clipUnitsMulti` 讓每個單元帶著 `rangeIdx`，而 `buildRenderPlan` 的接點判斷
   **一定要先看 rangeIdx**：兩個精華範圍可能落在同一個保留段裡（同一段話挑了兩句），
   這時 keepId 相同，落到 keepId 分支就會被當成「同段內的單元邊界」直接對接 ——
   聽起來是中間被硬生生挖掉一塊、沒有任何過渡。
   重疊的範圍一定要先合併（`normalizeRanges`），否則同一段聲音會在合輯裡出現兩次，
   而且中間插著一個交越，聽起來像結巴。
   合輯**不寫章節、不帶配樂**：散落的範圍上「配樂該在哪」沒有定義，硬帶只會得到
   一堆被切碎、對不上任何東西的片段 —— 不如明確地不帶。
   精華片段存 `store/highlights.ts`（跟 cleanup 一樣不進 undo：它是「我挑了哪幾段」的收藏，
   畫面上就有逐筆移除按鈕，塞進剪輯的復原歷史只會讓 Ctrl+Z 難以預期），存檔走 persist.ts。
   實測三段各 3 秒、交越 120 ms：預估 8760 ms、成品 8760 ms，差 0。

6. **EDL**（`analysis/edl/build.ts`）：字邊界 pad → 貼低能量點 → 合併 → 單句剪除比守門 → 補集為保留段 → 呼吸回填 / room tone gap → src↔out 映射（剪後時鐘、跳播）。
7c. **曲風轉換**（）： 用 ffmpeg 把選取切成 44.1k 立體聲 wav → multipart POST /v1/music/style（cover_strength 決定貼近原曲的程度）→ 同一套 music job 輪詢 / 下載 → 加進媒體清單。
7b. **AI 配樂**（`pipeline/music.ts` → `ttls::music_*`）：POST /v1/music（ACE-Step，非同步）→ 每 3 秒輪詢 → GET audio?i=N 下載各候選寫檔 → 加進媒體清單；BPM / 長度由 UI 從偵測到的拍網格與目前選取帶入。
7. **去人聲**（`pipeline/separate.ts` → `ttls::separate`）：上傳原檔到 `/v1/separate`（demucs htdemucs，同步、各軌 base64）→ 寫 `<來源>_vocals` / `_accompaniment` → 加入媒體清單。
8. **ASR 驗收**（`pipeline/verify.ts` + `analysis/verify.ts`）：成品 → `media_prepare` → ttls 轉寫 → `expectedWords(EDL)` × 成品逐字稿做帶狀 Levenshtein 對齊 → 漏字 / 該剪沒剪 / 接縫 ±600 ms 標記；報告存在 `store/verify.ts`（不進專案檔），UI 可逐筆試聽或跳去修。
9. **輸出**（`render.rs`）：保留段再依 VAD 切成 ≤15 s 單元 → BS.1770 閘門量測 → 增益規劃（clamp ±12 dB、峰值守門、平滑、階差 ≤3 dB）→ Rust 串流剪接（等功率 crossfade / seam / gap）→ `concat.wav` → ffmpeg loudnorm 兩趟 + alimiter → mp3 / m4a / wav。

## 祕密與隱私

- ttls API key：Settings → `ttls_key_set` → OS keychain（service `ai-music-cut`）。唯一讀取點 `ttls::api_key()`；沒有任何 command 回傳它；專案檔 / 設定檔 / log 不含金鑰（`format.test.ts` 與 `store.rs` 測試斷言）。
- claude 走使用者本機登入；MCP server 只綁 loopback、每次啟動隨機 bearer token，只給自家 claude 子程序。
- `scripts/check-secrets.mjs` 在 `npm run check` 掃 tracked files。

## 專案檔 `*.aicut.json`（schemaVersion 1）

## analysis.bin 版本與零交越（v3）

`media.rs` 產生的 `analysis.bin` 版面：

```
"AIPK" u32 version u32 pps u32 hop_ms u32 sr u32 n_buckets u32 n_win u64 total_samples
→ i8[n_buckets] min → i8[n_buckets] max → u8[n_buckets] rms
→ u8[n_buckets] zero-cross（v3 起）→ f32[n_win*3]
```

**v3 多的那一段**是「桶內第一個上升零交越的樣本位移」（255 = 沒有），每桶 1 byte、
30 分鐘約 +360 KB。剪點對到零交越才不會在波形中間硬切出 click ——
5 ms 桶對 100 Hz 基頻（週期 10 ms）根本定位不到零點。

三段式細修在 `buildEdl` 內完成（`analysis/edl/build.ts` 步驟 2），
所以 `outStartMs` 就是最終值；**不要**在 EDL 之後平移 `RenderPlan` 的 `src_*_ms`，
那會重新製造 R3 才修好的累積漂移。

讀快取一定要先驗 header（`analysis_header_ok`）：magic、版本、長度三項都要對。
舊版只看「檔案非空」，v3 的解析器讀到 v2 快取會整個錯位而且**完全不報錯** ——
症狀是波形亂掉、剪點全錯。版本不符就刪檔重算（30 分鐘約 20–40 秒）。
前端的 `parseAnalysis` 仍然讀得動 v2（只是 `zx` 為 null），所以舊 session 留在記憶體
或專案檔裡的分析不會壞。

**已知限制**：分析走 mono 下混、render 走原聲道，所以下混後的零點不保證在每個聲道
都成立。靠接點協定的 ≥4 ms 等功率交叉兜底（`analysis/edl/fade.ts`）。


`media[]`（路徑 / 指紋 / probe）、`settings`（激進度 / 目標響度）、`analysis[mediaId]`（`transcript`、`candidates`、`decisions`、`effects`、`llm` 視窗快取）。沒逐字稿但有人工剪輯 / 效果也會存。CLI `cut --project` 讀同一格式。媒體快取（opus / analysis.bin / transcript.json）在 `%LOCALAPPDATA%\net.markkulab.aimusiccut\media\<fp16>\`，同檔重開免重跑。

## dev 鉤子（只在 debug build 生效）

`AICUT_DEV_OPEN=<音檔>`、`AICUT_DEV_ANALYZE=1`、`AICUT_DEV_JUDGE=1`、`AICUT_DEV_RENDER=1`、`AICUT_DEV_ASK="…"`：啟動即自動開檔 / 分析 / 判讀 / 輸出 / 問助手，方便煙霧測試。前端錯誤透過 `client_log` 印到 `tauri dev` 終端。
