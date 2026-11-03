//! 音乐和声研究工作台 —— 后端入口。
//!
//! 模块划分：
//!   `audio_fingerprint`  音频指纹（时长 + 头尾哈希），用于路径失效后的重连
//!   `db`                 SQLite 数据层（权威）+ 分析结果 JSON 副本（可移植）
//!   `analyzer`           分析引擎抽象（Python 子进程 / 未来的 ONNX）
//!   `commands`           Tauri 命令（导入、分析、重连、读取）
/// 完整分析链的 Rust 编排（Phase 2：零 Python 分发）
mod analysis;
mod analyzer;
/// 本地推理用音频前处理（Phase 2：零 Python 分发）
mod audio;
mod audio_fingerprint;
/// ONNX 本地推理（Phase 2：替换 Python 子进程）
mod model;
mod commands;
mod db;

use analyzer::Analyzer;
use commands::AppState;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据目录：Windows 上是 %APPDATA%/<bundle-id>/
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("无法定位应用数据目录");
            std::fs::create_dir_all(&data_dir).ok();
            eprintln!("[data] {}", data_dir.display());

            let db = db::Db::open(&data_dir).expect("数据库初始化失败");

            // 分析引擎：默认 Rust + ONNX（自包含，不依赖 Python）。
            // 只有模型缺失且开发机上能找到 `neural/analyze_song.py` 时才回退 Python。
            // 想强制用 Python 对照：`MUSICANAZ_ANALYZER=python`。
            let analyzer: Option<Box<dyn Analyzer>> = analyzer::build_analyzer();

            app.manage(AppState {
                db: Arc::new(Mutex::new(db)),
                analyzer: Arc::new(analyzer),
                running: Arc::new(Mutex::new(Vec::new())),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_audio,
            commands::analyze_song,
            commands::list_songs,
            commands::load_analysis,
            commands::save_edits,
            commands::load_edits,
            commands::delete_song,
            commands::scan_missing_audio,
            commands::get_fingerprint,
            commands::evaluate_reconnect_candidate,
            commands::confirm_reconnect,
            commands::song_audio_path,
            commands::write_text_file,
            commands::read_text_file,
            commands::import_fbsong,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
