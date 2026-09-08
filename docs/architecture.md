# 架構

```
┌─ ai-podcast-cut (Tauri 2 desktop) ─────────────────────────────────────────────┐
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
3b. **人工剪輯**（`store/timeline.ts` + `timeline/selectionActions.ts`）：選取工具拖出 `selection` → 剪掉（manual 候選）/ 只保留 / 播放（可循環）；區段效果（`analysis/effects.ts`：mute / gain / fade_in / fade_out / invert，淡入淡出可選 linear / equal_power / exponential 曲線；`analysis/levels.ts` 從 analysis.bin 算峰值正規化 / 響度對齊 / 噪音樣本，結果都是普通 gain 效果；範圍濾波（降噪 / 去爆音 / 去削波 / 去嗡聲 / DC）存成 params 袋，`analysis/fx/regions.ts` 換算到成品時間 → Rust `fx.rs` 在 concat.wav 上串流 punch-in（每段一個小 ffmpeg、pre-roll 暖機、10 ms 交叉、frame 數不變）；A/B 試聽走 `fx_preview` 對來源檔直接切段；EQ / 壓縮 / 回音 / 殘響 / 反轉 / 變調也是同一套（`effects/specs/tone.ts`），反轉 / 變調 `correlated=false` → 等功率交叉、驗收只比位置。頻譜視圖 `timeline/SpectrogramLayer.tsx` ← `pipeline/spectrogram.ts` ← Rust `spectrum.rs`（showspectrumpic on-demand PNG）；嗡聲偵測 `analysis/spectrum.ts findHum` 吃 `media_spectrum`（純 Rust FFT 平均功率譜）。輸出格式單一來源 `analysis/formats.ts` ↔ Rust `formats.rs`（七種、章節能力、codec golden）；轉檔 `dialogs/ConvertDialog` → `pipeline/convert.ts`（序列、逐檔隔離）→ Rust `convert.rs`（plan / can_copy / 兩趟 loudnorm）；合併 `dialogs/MergeDialog` → `analysis/mergePlan.ts` → Rust `merge.rs`（filter graph、>40 走 script）。時間對齊 `dialogs/AlignDialog` → `pipeline/align.ts`（粗→細帶狀 DTW：`analysis/align/{features,dtw,warp,residual}.ts`）→ Rust `align.rs`（asendcmd 驅動的單一 atempo）；「同步麥克風」的漂移校正也走它。錄音 `recording/capture.ts`（getUserMedia + AudioWorklet → raw-body IPC）→ Rust `record.rs`（hound 24-bit wav）；「重錄這句」`recording/punchIn.ts`（trim / fit / planRedub）+ `decisions.applyRedub`（mute + overlay 一個 commit）+ 對齊引擎 ADR 模式）以來源時間包絡定義，預聽用 `<audio>.volume`，輸出由 Rust 逐 frame 相乘（同一套 5 ms 邊緣平滑）。
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
   ③ `cut_text` 在 undo 堆疊上留下兩筆一模一樣的紀錄，第二筆什麼都沒改 ——
   使用者按一次 Ctrl+Z 看起來完全沒反應。`addManualCuts` 改成只在真的有變動時才 commit
   （新增了候選，或有段落原本被拒絕、這次改回 accepted）。
   **注意當時的歸因是錯的**：我判斷成「claude 重試了同一個查詢」，實際上是每個 MCP 呼叫
   都被執行兩次（見 5t）。修法本身仍然正確而且該做 —— agent 確實會重試 ——
   但真正的病灶在別的地方，而這個冪等修補等於順手把它遮得更嚴實。
   通則兩條：**寫入工具要能安全重跑，而且「沒事可做」不等於「做了一件空事」**；
   還有 —— **看到「同一個操作出現兩次」，先確認是誰呼叫了兩次，不要預設是對方重試。**

5t. **每個 MCP 工具都被執行兩次**（`App.tsx` 的工具橋 effect）：
   `installToolBridge()` 是非同步的，而 React StrictMode 在 dev 會 mount → unmount → mount。
   第一次的 cleanup 跑在 promise 解決之前，`un` 還是 `undefined`，所以**什麼都沒拆**；
   兩次註冊都留著，每個 `mcp-tool-call` 事件被處理兩次。
   冪等的工具完全看不出來，但 `lift_selection` 這種會**消耗**狀態的就會炸：
   第一次成功並清掉選取，第二次找不到選取而丟例外，兩個結果在 Rust 那邊搶同一個 oneshot。
   修法是 effect 加 `cancelled` 旗標（promise 解決時若已卸載就立刻拆掉），
   外加 `installToolBridge` 自己記住上一個監聽、多裝一次就先拆舊的。
   診斷的關鍵是一個矛盾：**工具回報失敗，但它該做的副作用確實發生了** —— 那只能是執行了不只一次。

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
   合輯**不寫章節**，也不帶 store 裡的配樂：那些是釘在完整成品時間軸上的，合輯的時間軸完全不一樣，
   硬帶只會得到一堆被切碎、對不上任何東西的片段。要墊樂就**現生一條**鋪滿整支預告
   （−22 dB、頭尾淡進淡出、不做閃避控制點 —— 預告是 wall-to-wall 講話，
   壓成固定的底反而比一路上上下下乾淨）。
   頭尾的淡入淡出**只加進這一趟的 plan，不寫進 store**：那是輸出這支預告的處理，
   不是對專案的編輯；寫進去的話完整成品也會莫名其妙在那兩個位置淡掉。
   精華片段存 `store/highlights.ts`（跟 cleanup 一樣不進 undo：它是「我挑了哪幾段」的收藏，
   畫面上就有逐筆移除按鈕，塞進剪輯的復原歷史只會讓 Ctrl+Z 難以預期），存檔走 persist.ts。
   實測三段各 3 秒、交越 120 ms：預估 8760 ms、成品 8760 ms，差 0。

5s. **節目筆記**（`analysis/shownotes.ts` + `pipeline/shownotes.ts`）：
   走 `claude_structured`（帶 JSON schema）而不是聊天 —— 這是一次性的結構化產出，
   不需要工具迴圈，也不該塞進助手的對話歷史。
   **這裡唯一難的事情是時間**：逐字稿在來源時間軸上，節目筆記給的是聽眾在成品裡看到的時間，
   中間隔著整份 EDL。所以餵給 claude 的素材先用 `mapSrcToOut` 換算好、被剪掉的句子直接不餵，
   它回來之後再對節目長度驗一次。claude 完全不需要知道 EDL 的存在。
   `normalizeShowNotes` 擋掉四種會出事的回應：時間戳看不懂、超出節目長度、章節沒有遞增、
   第一個章節不是 0（開頭會有一段沒有章節的空窗）。**寧可丟掉一筆，也不要寫出聽眾按下去
   跳到空氣的章節。** 章節要寫成標記時再 `mapOutToSrc` 換回來源時間（標記釘在來源上）。
   實測：成品 8000 ms 的章節 → 來源 12254 ms（正確落在 5–9 秒的剪除區之後）→ 換回來還是 8000 ms，
   寫進檔案的那一份也一致。

6. **EDL**（`analysis/edl/build.ts`）：字邊界 pad → 貼低能量點 → 合併 → 單句剪除比守門 → 補集為保留段 → 刀片切點 → **貼上排列**（`edl/arrange.ts`）→ 呼吸回填 / room tone gap → src↔out 映射（剪後時鐘、跳播）。

   > **v0.97 打破了一個維持很久的不變式，這件事值得單獨記一段。**
   >
   > 在此之前 `keeps` 是「剪除區間的補集」，因此天生保證三件事：依 `srcStartMs` 遞增、彼此不重疊、
   > 每一段來源最多出現一次。整個下游（接點、輸出時間帳、字幕、章節、跳播、驗收）都直接或間接靠著它。
   >
   > 剪下貼上與搬移把這三件事全部打破：keeps 現在是**成品順序**，來源起點可能忽大忽小（搬移），
   > 同一段來源可能出現兩次（複製），而 `keeps[i].srcStartMs` 與 `keeps[i-1].srcEndMs` 之間**沒有任何關係**。
   >
   > 撐得住的部分是刻意確認過的：`RenderSeg` 本來就只是一串照順序接起來的來源區間（Rust 完全不用改），
   > 而步驟 7 的接點與輸出時間帳是照**陣列順序**累加的，並沒有假設來源順序。
   >
   > 撐不住的是查表：`mapSrcToOut` 原本依來源順序掃、回第一個命中。所以它現在會先用 `isRearrangedKeeps`
   > 偵測重排，改走 `arrange.ts` 的 `srcToOutArranged`（規則：一段來源出現兩次時回**成品裡最早**的那一次）。
   > 在單一入口分流而不是改十幾個呼叫端的簽章 —— 漏掉一處就是一個不會報錯的 bug：
   > 字幕整份慢慢飄掉、章節跳到不對的地方。
   >
   > **之後動到 keeps 的人請先問一句：這段程式碼有沒有假設來源順序？**
7c. **曲風轉換**（）： 用 ffmpeg 把選取切成 44.1k 立體聲 wav → multipart POST /v1/music/style（cover_strength 決定貼近原曲的程度）→ 同一套 music job 輪詢 / 下載 → 加進媒體清單。
7b. **AI 配樂**（`pipeline/music.ts` → `ttls::music_*`）：POST /v1/music（ACE-Step，非同步）→ 每 3 秒輪詢 → GET audio?i=N 下載各候選寫檔 → 加進媒體清單；BPM / 長度由 UI 從偵測到的拍網格與目前選取帶入。
7. **去人聲**（`pipeline/separate.ts` → `ttls::separate`）：上傳原檔到 `/v1/separate`（demucs htdemucs，同步、各軌 base64）→ 寫 `<來源>_vocals` / `_accompaniment` → 加入媒體清單。
8. **ASR 驗收**（`pipeline/verify.ts` + `analysis/verify.ts`）：成品 → `media_prepare` → ttls 轉寫 → `expectedWords(EDL)` × 成品逐字稿做帶狀 Levenshtein 對齊 → 漏字 / 該剪沒剪 / 接縫 ±600 ms 標記；報告存在 `store/verify.ts`（不進專案檔），UI 可逐筆試聽或跳去修。
9. **輸出**（`render.rs`）：保留段再依 VAD 切成 ≤15 s 單元 → BS.1770 閘門量測 → 增益規劃（clamp ±12 dB、峰值守門、平滑、階差 ≤3 dB）→ Rust 串流剪接（等功率 crossfade / seam / gap）→ `concat.wav` → ffmpeg loudnorm 兩趟 + alimiter → mp3 / m4a / wav。

## 殼層：指令註冊表 / 對話框 store / 選單（v0.98）

以前 `App.tsx` 有 22 個對話框 boolean、`Toolbar` 有 41 個 props、快捷鍵表是手抄的。
每加一個功能要改五個地方，而且五個地方會慢慢對不上（快捷鍵說明就漏了 Alt+X、Shift+I/O）。

現在「使用者做得到的動作」只寫一次：

| 檔案 | 職責 |
|---|---|
| `src/commands/types.ts` | `Command { id, title(zh key), group, shortcuts, enabled(): {ok} \| {ok:false, why}, run() }`；`simple*` 欄位給簡易模式 |
| `src/commands/registry.ts` | zustand store（id 為鍵 → 熱更新冪等）；`runCommand` 是**唯一入口**：不能做就 toast 原因（同一句 1.5 秒內不重複）、能做就跑並接住例外。**不 import 任何 store / Tauri**，測試可直接載 |
| `src/commands/guards.ts` | `needsMedia / needsSelection / needsAnalysis…` 守門；`installCommandReactivity` 訂閱幾個 store 的關鍵欄位、有變就 bump 版本計數（播放線不算） |
| `src/commands/core.ts`、`effectCommands.ts` | 指令本體。在 `scripts/check-i18n.mjs` 的 `TABLE_SOURCES`（`commands/`）裡：每一條 title / why 都得進 locales |
| `src/commands/shortcut.ts` | chord 解析 / 比對 / 顯示。**修飾鍵精確相等**；`effectiveKey` 處理中文輸入法（key 是 "Process" 時從 code 推回） |
| `src/commands/menuModel.ts` | 指令 → `MenuItem`：section 之間畫線、停用的 `muted + title`、quick 先於 dialog；`selectionMenuItems` 是選取右鍵（專業 = 效果 ▸ / 修復 ▸；簡易 = 固定七格白話） |
| `src/commands/appActions.ts` | 從 App.tsx closure 搬出來的動作（openMedia / saveProject / analyzeWithPreflight…），不需要 React |
| `src/hotkeys.ts` | 只剩 JKL 與方向鍵手寫；其餘由註冊表派發。`global` 指令（F1、Ctrl+K）排在「對話框開著就讓路」之前 |
| `src/store/dialogs.ts` + `src/shell/DialogHost.tsx` | 對話框改成 id 堆疊；每個對話框各自 code-split（`ui/lazyOverlay`）；`needs:"media"` 的在 active media 消失時自動關 |
| `src/ui/MenuPanel.tsx` | 右鍵 / 下拉 / 子選單共用：hover 120 ms 開子選單、↑↓ Home End 首字導覽、`muted`；子選單的 DOM 也算「在選單裡面」（不然滑進 flyout 會被當成點外面） |
| `src/shell/CommandPalette.tsx` | Ctrl+K。同時比翻譯後標題、繁中原文、關鍵字、快捷鍵；停用的也列出來、右邊寫原因 |
| `src/shell/ProShell.tsx` / `SimpleShell.tsx` | 兩個殼。專業 = 工具列 · 流程列 · [媒體 \| Workspace + 逐字稿 \| 右側欄]；簡易 = 小標題列 · 三步流程列 · [Workspace + 逐字稿 \| SimplePanel]。`store/ui.mode` 決定掛哪個；第一次裝是簡易、升級前有 blob 的是專業（`parsePersisted`） |
| `src/shell/Workspace.tsx` / `TranscriptArea.tsx` | 從 MainArea 抽出來的波形區（傳輸列 / 時間軸 / 概覽 / 四個右鍵 / 播放相關 hook）與逐字稿區。兩個殼掛的是**同一份**，`variant` 只決定拿掉什麼 |
| `src/shell/SimplePanel.tsx` | 簡易面板：復原 + `simplePanelCommands()`（`simple` + `simpleOrder` 的指令，≤8 顆）+ 輸出。停用不灰掉：第二行灰字是原因 |
| `src/commands/undoToast.ts` + `toast.undo` | 每個破壞性動作後面一顆「復原」；只退自己那一筆（歷史頂端不是自己就改成提示） |
| `src/effects/spec.ts` + `registry.ts` | 有參數的效果寫成 `EffectSpec`（params ≤3、presets、suggest、build）；`registerEffectSpec` 產生 `<id>.dialog / .preset.<p> / .quick` 指令。`dialogs/EffectDialog.tsx` 只是把 spec 畫出來 |

規矩：
- 新功能 = 一條 `Command`（或一支 `EffectSpec`），不要再往 Toolbar / App.tsx 加 props 與 boolean。
- 快捷鍵只寫在 `shortcuts`；`registry.test.ts` 的 `duplicateChords` 抓雙綁。
- 停用要給 `why`（zh key）。畫面上不會灰掉不解釋：tooltip、toast、命令面板右側都是同一句。
- 兩個 store（`useCommands`、`useDialogs`）要從 `window.__aicut` 拿（見 dev 鉤子），不要手動 `import()`：HMR 之後那是另一個實例。

## 對齊渲染：自己的 WSOLA（v0.109）

- `src-tauri/src/align.rs`：`WarpMap`（分段線性，輸出 frame → dub frame）+ `wsola()`（20 ms Hann grain、10 ms hop、每格回到理想位置 ±5 ms 內用 NCC 找接法、離理想位置越遠扣分）。輸入是 ffmpeg 解出來的 f32 串流（`FrameSource` trait，`Window` 滑動視窗記憶體有界），輸出 24-bit wav 串流寫。位移正 = 前面補靜音、負 = 跳過扭完之後的開頭。
- 為什麼不用 atempo：runtime 換速每次 −21 ms；每段獨立 + 脈衝校準在脈衝列上準、在語音上穩定晚 30 ms（WSOLA 往前找最像的地方，落點平均值跟內容有關）。這裡的設計反過來：每格都回到理想位置找，誤差有界且不累積。純 Rust 測試：脈衝列 0.9 / 1.1 / 1.0 三段 ≤ 2.1 ms、1.0 倍透明、立體聲同落點、正弦無 click；`#[ignore]` 真解碼 roundtrip 含正負位移。
- `fx.rs wet_filter`：`-ss/-t` 都放在 `-i` 前（輸入選項）+ `atrim=end_sample` 切準 + 非反轉鏈 `apad` 補 post-roll。`-t` 放輸出端時 areverse / showspectrumpic 會把檔案讀到底。
- `convert.rs plan`：重編一律明講 `-ar`（loudnorm 內部 192 kHz）、Opus 只收 8/12/16/24/48 kHz。
- `commands::paths_exist`：前端決定輸出檔名前先問磁碟（`pipeline/convert.ts planOutPathsOnDisk`、`recording/naming.ts nextTakeIndexOnDisk`、`pipeline/align.ts freeAlignedPath`）；後端沒有這支指令時三處都退回只看媒體清單。

## 選單列 / 一鍵修 / 來源時間錨定（v0.107）

- `shell/MenuBar.tsx`：專業模式專用，`groupMenu(g, "menu")` 把註冊表裡 file / edit / select / playback / effect / repair / tool / ai / view / help 十個群組各長成一個 `MenuPanel`；滑過去（mouseover）就切換開著的選單；簡易模式不掛。
- `analysis/fx/repairs.ts`：`repairsForQc(findings, durationMs)` 把輸出前檢查的削波 / DC 找到的位置換成 `declip`（±100 ms 合併）/ `dc`（整檔）效果，`origin: "qc"`；`RenderDialog` 每條檢查旁的「一鍵修」= `addEffects` + `toast.undo`。
- `analysis/overlays.ts`：`Overlay.anchorSrcMs?` —— 有值的 overlay 位置每次都用 `effectiveOutStartMs(o, keeps)` 從 EDL 重算（`resolveOverlays` 給 render / 監聽 / 車道 / 驗收四個消費者）。重錄這句（`punchIn.planRedub`）與「放一段音檔進來」（`commands/clipCommands.ts importIntoSelection`）都錨在來源時間；`decisions.updateOverlay` 收到手動 `outStartMs` 就解除錨定。
- `store/project.ts openMedia(path, { activate: false })`：只加進清單不切 active。take / 對齊檔 / 匯入素材都走這條 —— 切過去再切回來會讓主角重載、播放頭歸零、預覽清掉（React 在 await 之前就 commit 了那一瞬間）。
- `store/dialogs.ts open()`：同 id 重開時 props 相同才保留 key；props 不同（另一段選取、另一句要重錄）換 key 重掛。

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
