# 量測腳本

這幾支不是測試，是**量尺**。

測試回答「行為有沒有變」，量尺回答「這個常數對不對」——後者沒有辦法用推理決定，
只能拿真的錄音去問。這裡的每一支都對應到一次「本來以為 X，量了才知道是 Y」：

| 腳本 | 回答的問題 | 量出來過的事 |
| --- | --- | --- |
| `breath.mjs` | 剪完之後留白該多長？ | 「段落」原本靠句號判斷，而中文每句都有句號 —— 被判成段落的地方實際只停 140 ms，App 卻在那裡塞 575 ms（v0.127） |
| `snap.mjs` | 吸附吸得準不準？ | 瞄著既有接縫拖，36/100 被更近的字界搶走；但掃描成本每次只有 0.06 ms，**不是**效能問題（v0.124） |
| `render-length.mjs` | 計畫的長度就是拿到的長度嗎？ | v0.97 只驗了 TS 端的計畫就發版，實際渲染少了 16 秒而且不報錯 |

## 怎麼跑

量尺要對著**跑起來的 App** 問（真資料在裡面：逐字稿、EDL、播放器），
所以先用開了偵錯埠的方式啟動，再跑腳本。

```bash
# 1) 開 App（換成你自己的錄音；要量呼吸 / 吸附的話 ANALYZE=1 讓它跑完辨識）
AICUT_DEV_OPEN=/path/to/你的錄音.m4a AICUT_DEV_ANALYZE=1 \
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*" \
npm run tauri dev

# 2) 另一個終端機
npm run measure:breath
npm run measure:snap
npm run measure:render
```

Windows PowerShell 設環境變數是 `$env:AICUT_DEV_OPEN = "..."`，不是 `VAR=x cmd`。

## 讀結果

- `breath` / `snap` 會在數字明顯不對時標 `⚠` 並指出該回頭看哪個檔案。
- `render-length` 對不上會以非 0 結束碼退出 —— 那是會**安靜**交出壞檔的那種錯。

## 兩個會讓你白量的坑

1. **`#root` 只能有一個子節點。** 熱更新會把整棵 App 疊第二份上去（`createRoot`
   對同一個容器重跑），那時候量 DOM 會拿到兩份混在一起的答案。`waitReady` 會擋。
2. **`Runtime.evaluate` 要帶 `userGesture: true`。** 不帶的話播放相關的量測會被
   自動播放政策擋掉，而症狀是「全部回 0」，看起來像功能壞了。`cdp.mjs` 已經帶了。

## 加一支新的量尺

值得加的判準是：**它回答的問題，只有真資料答得出來。**
「這個函式回傳對不對」是測試的事，寫成量尺只是把測試放到不會自動跑的地方。
