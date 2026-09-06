mod agent;
mod cleanup;
mod commands;
mod error;
mod ffmpeg;
mod mcp;
mod mix;
mod media;
mod proc;
mod project;
mod render;
mod store;
mod ttls;

use tauri::Manager;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|app| {
            // dev 便利：repo 根的 .env.local（gitignored）。只在 debug build 讀，
            // 且 keychain 沒金鑰時才會用到（見 ttls::api_key）。tauri dev 的 cwd 是 src-tauri。
            #[cfg(debug_assertions)]
            {
                let _ = dotenvy::from_filename("../.env.local");
            }
            let handle = app.handle().clone();
            let loaded: store::AppSettings =
                tauri::async_runtime::block_on(store::read_json(&handle, store::SETTINGS_FILE))
                    .unwrap_or_default();
            *handle.state::<AppState>().settings.write() = loaded;
            // 安裝檔內建的 ffmpeg（bundle.resources）。dev 時 resource_dir 是 src-tauri，
            // 那裡也剛好有 resources/ffmpeg（fetch-ffmpeg.mjs 放的），所以本機也能測到同一條路徑。
            {
                let dir = app.path().resource_dir().ok().map(|r| ffmpeg::bundled_candidate(&r));
                if let Some(d) = dir.filter(|d| d.is_dir()) {
                    eprintln!("[ffmpeg] bundled dir: {}", d.display());
                    *handle.state::<AppState>().bundled_ffmpeg.write() = Some(d);
                }
            }
            // 內建 MCP server（loopback + 隨機 token）；綁不到 port 只影響 AI 助手，不擋 App 啟動。
            {
                let bridge = handle.state::<AppState>().mcp.clone();
                match tauri::async_runtime::block_on(mcp::start(handle.clone(), bridge)) {
                    Ok(port) => eprintln!("[mcp] listening on 127.0.0.1:{port}"),
                    Err(e) => eprintln!("[mcp] failed to start: {e}"),
                }
            }
            // 保險絲：視窗以 visible:false 啟動，正常由前端骨架屏呼叫 show_main_window；
            // 若前端 4 秒內沒呼叫（bundle 載入失敗 / JS 錯誤），強制顯示以免看起來像沒啟動。
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_main_window,
            commands::client_log,
            commands::dev_env,
            commands::settings_get,
            commands::settings_set,
            commands::app_paths,
            commands::ffmpeg_detect,
            commands::media_probe,
            commands::media_fingerprint,
            commands::media_cache_status,
            commands::media_prepare,
            commands::media_analyze_local,
            commands::media_cancel,
            commands::media_cache_write_transcript,
            commands::media_cache_read_transcript,
            commands::media_cache_clear,
            commands::ttls_health,
            commands::ttls_key_status,
            commands::ttls_key_set,
            commands::ttls_key_clear,
            commands::ttls_key_verify,
            commands::ttls_transcribe_start,
            commands::ttls_separate,
            commands::media_clip,
            commands::media_combine,
            commands::ttls_gpu_release,
            commands::ttls_music_start,
            commands::ttls_music_style_start,
            commands::ttls_music_poll,
            commands::ttls_music_fetch,
            commands::ttls_music_cancel,
            commands::ttls_transcribe_poll,
            commands::ttls_transcribe_result,
            commands::ttls_transcribe_cancel,
            commands::render_start,
            commands::render_cancel,
            commands::project_save,
            commands::write_text_file,
            commands::project_load,
            commands::open_path,
            commands::open_external,
            agent::claude_detect,
            agent::claude_send,
            agent::claude_cancel,
            agent::claude_structured,
            mcp::mcp_set_tools,
            mcp::mcp_tool_result,
            mcp::mcp_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
