//! 音频前处理（本地推理用，零 Python 依赖）。
//!
//! ## 为什么要自己写
//!
//! 原来整条分析链跑在 Python 子进程里，依赖 conda 环境 **5.2 GB**
//! （PyTorch + librosa + scipy + sklearn + numba）。产品没法这样分发。
//!
//! 这里用纯 Rust 复现 Python 侧的每一步，配合 ONNX 推理（`ort`），
//! 目标安装包 50~120 MB。
//!
//! ## 子模块
//!
//! - [`decode`] 用 symphonia 解码成 f32 mono（容忍尾部损坏）
//! - [`resample`] 转 22050 Hz（beat_this 的训练采样率）
//! - [`mel`] log-mel 谱（beat_this 的输入）

pub mod chroma;
pub mod cqt;
pub mod decode;
pub mod mel;
pub mod resample;
pub mod stft;
pub mod tuning;

#[cfg(test)]
mod golden_tests;

/// beat_this 的训练采样率。CQT / mel 全部以它为基准。
pub const ANALYSIS_SAMPLE_RATE: u32 = 22050;
