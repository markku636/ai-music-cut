// 產品名 v0.108 起改成 AI Podcast Cut（原名 AI Music Cut）。GitHub repo 網址、部落格工具頁 slug、
// bundle identifier、keychain service 都刻意留舊值：改了會讓舊連結失效、使用者的設定 / API key 找不到。
export const APP_NAME = "AI Podcast Cut";
export const REPO_URL = "https://github.com/markku636/ai-music-cut";

/**
 * 部落格上的工具介紹頁（免費工具那一欄）。
 *
 * 「有新版，點擊前往下載」導到這裡而不是 GitHub Release：
 * 那一頁有安裝說明、快速上手與截圖，而 GitHub 的 Release 頁對非工程師
 * 只是一串看不懂的檔名。下載連結本來就掛在那一頁上。
 */
export const TOOL_PAGE_URL = "https://blog.markkulab.net/tools/ai-music-cut";
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "flac", "ogg", "opus", "aac", "wma", "aiff", "mp4", "m4b"];
/** 影片容器：每個 ffmpeg 呼叫本來就 -vn，開進來直接當聲軌用（轉檔 / 剪輯都行）。 */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "flv", "wmv"];
export const MEDIA_EXTENSIONS = [...new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])];
