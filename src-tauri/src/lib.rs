mod commands;
mod error;
mod ffmpeg;
mod proc;
mod project;
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
            commands::settings_get,
            commands::settings_set,
            commands::app_paths,
            commands::ffmpeg_detect,
            commands::media_probe,
            commands::media_fingerprint,
            commands::ttls_health,
            commands::ttls_key_status,
            commands::ttls_key_set,
            commands::ttls_key_clear,
            commands::ttls_key_verify,
            commands::project_save,
            commands::project_load,
            commands::open_path,
            commands::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
