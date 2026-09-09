//! 子程序共用：不彈黑窗（Windows）、stdin 關閉、`where`/`which` 查找。
use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 建立子程序指令：stdin 預設關閉（ffmpeg 遇到關閉的 stdin 會卡住的問題另以 `-nostdin` 處理）。
pub fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null());
    // **Windows 上 Python 寫進「管線」用的是 ANSI 代碼頁（zh-TW 是 cp950），不是 UTF-8。**
    // 我們的 sidecar 用 ensure_ascii=False 輸出中文，所以那些 bytes 不是合法 UTF-8，
    // Rust 這邊 `lines()` 會回 Err、讀取迴圈直接結束 —— 沒有人再讀 stdout 之後管線塞滿，
    // python 就卡在下一次 flush，最後以結束碼 120 退出。
    // 短檔看不出來（寫不滿 64 KB），16 分鐘的節目必掛，而且中間的進度事件一直在被丟掉。
    // 對非 python 的程式（ffmpeg…）這兩個變數沒有作用，設了無害。
    c.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// `where` / `which` 找可執行檔；回全部候選（依 PATH 順序）。找不到回空。
pub async fn which(name: &str) -> Vec<String> {
    let prog = if cfg!(windows) { "where" } else { "which" };
    let mut c = cmd(prog);
    c.arg(name);
    let out = match c.output().await {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// 用 OS 檔案總管開啟並選取檔案（fire-and-forget）。
pub fn reveal(path: &std::path::Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer");
        if path.is_file() {
            c.arg(format!("/select,{}", path.display()));
        } else {
            c.arg(path);
        }
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        if path.is_file() {
            c.arg("-R");
        }
        c.arg(path);
        let _ = c.spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if path.is_file() { path.parent().unwrap_or(path) } else { path };
        let _ = std::process::Command::new("xdg-open").arg(target).spawn();
    }
}

/// 以系統預設瀏覽器開啟外部連結（僅 http/https）。
pub fn open_url(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}
