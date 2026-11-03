//! ONNX 模型推理。
//!
//! 目前有：
//! - `beat`：beat_this 的拍点 / 小节检测（1 个模型）
//! - `chord`：lv-chordia 的 ChordNet 和弦识别（5 折 ensemble）
//! - `postprocess`：beat_this 的后处理（峰值提取 + downbeat 吸附）

pub mod beat;
pub mod chord;
pub mod postprocess;
pub mod structure;
pub mod xhmm;

use std::path::PathBuf;

use anyhow::Result;

/// 定位随程序分发的模型 / 数据文件。
///
/// 优先级（和 [`crate::model::beat::find_ort_dll`] 一致的思路）：
/// 1. 可执行文件同目录（打包后 Tauri 把 resource 放在这里）
/// 2. 可执行文件同目录下的 `assets/`（有些打包布局会保留子目录）
/// 3. 环境变量 `MUSICANAZ_ASSETS_DIR`（排查问题用）
/// 4. `CARGO_MANIFEST_DIR/assets`（**仅开发期**有效，打包后是构建机路径）
pub fn resolve_asset(name: &str) -> Result<PathBuf> {
    let mut tried: Vec<String> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for p in [dir.join(name), dir.join("assets").join(name)] {
                if p.exists() {
                    return Ok(p);
                }
                tried.push(p.display().to_string());
            }
        }
    }

    if let Ok(dir) = std::env::var("MUSICANAZ_ASSETS_DIR") {
        let p = PathBuf::from(dir).join(name);
        if p.exists() {
            return Ok(p);
        }
        tried.push(p.display().to_string());
    }

    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join(name);
    if dev.exists() {
        return Ok(dev);
    }
    tried.push(dev.display().to_string());

    Err(anyhow::anyhow!(
        "找不到资源文件 {name}，已尝试:\n  {}",
        tried.join("\n  ")
    ))
}

/// 读取二进制资源并断言长度，用于 golden 测试。
#[cfg(test)]
pub(crate) fn read_golden_f32(name: &str) -> Vec<f32> {
    let path = resolve_asset(name).unwrap_or_else(|e| panic!("{e}"));
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", path.display()));
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
