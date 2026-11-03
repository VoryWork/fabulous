//! beat_this 的 ONNX 推理 —— 拍点 / 小节（downbeat）逐帧 logits。
//!
//! # 为什么是「逐块」而不是「整首一次」
//!
//! 模型训练长度是 1500 帧（30 秒 @ 50fps）。更长的曲目必须分块，
//! 而分块会带来两个边界问题：
//!
//! - 块边缘的预测不可靠（训练时 loss 里有 max-pool，边缘没被监督过）
//!   → 每块两侧各丢 `BORDER = 6` 帧
//! - 块与块的预测在重叠区会冲突
//!   → 用 `keep_first`：**先到的块赢**（倒序写入，早的覆盖晚的）
//!
//! 这套逻辑是从 `beat_this/inference.py` 的 `split_piece` + `aggregate_prediction`
//! 一比一搬过来的，连 `avoid_short_end` 的行为都一样。
//!
//! # ⚠️ 绝对不要批处理（batch > 1）
//!
//! 导出的 ONNX 把 `(batch, frames)` 两个维度**拍平**了：喂 `(2, 601, 128)`
//! 得到的是 `(1, 1202)` 而不是 `(2, 601)`，而且两块**互相污染**
//! （实测单块 vs 拼块，前半段差 4.6、后半段差 9.2）。
//!
//! 这是导出时的 bug，但 Python 侧本来就是一块一块跑的（`model(chunk[None])`），
//! 所以从来没暴露。Rust 侧必须保持同样纪律：**一次只喂一块**。
//!
//! 性能上不吃亏：一块 1500 帧 = 30 秒音频，30 秒的曲子也就 2~3 次推理。

use anyhow::{Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::audio::mel::N_MELS;

/// 每块帧数。
pub const CHUNK_SIZE: usize = 1500;
/// 每块两侧丢弃的帧数。
pub const BORDER: usize = 6;

/// 逐帧 logits（未 softmax）。长度 = 输入帧数。
pub struct BeatLogits {
    pub beat: Vec<f32>,
    pub downbeat: Vec<f32>,
}

/// beat_this ONNX 会话。
pub struct BeatPredictor {
    // Environment 由 `ensure_ort()` 存在全局 OnceLock 里，进程生命周期内不 drop，
    // 所以这里不用再持有它。
    session: Session,
}

impl BeatPredictor {
    /// 从 ONNX 文件加载。模型约 83 MB，加载要几百毫秒，应该复用而非每次新建。
    /// 加载模型。ONNX Runtime 的 dll 会按 [`find_ort_dll`] 自动查找。
    pub fn load(model_path: &Path) -> Result<Self> {
        // load-dynamic：先 dlopen onnxruntime.dll，再建 Environment。
        // 这两步都只做一次（进程级），重复调用是安全的。
        let env = ensure_ort()?;
        let session = Session::builder(env)?
            .commit_from_file(model_path)
            .with_context(|| format!("加载 beat_this 模型失败: {}", model_path.display()))?;
        Ok(Self { session })
    }
}


/// ONNX Runtime 的 Environment（进程级单例）。
static ORT_ENV: OnceLock<ort::environment::Environment> = OnceLock::new();

/// 初始化 ONNX Runtime。第一次调用 dlopen dll，之后直接复用。
pub(crate) fn ensure_ort() -> Result<&'static ort::environment::Environment> {
    if let Some(env) = ORT_ENV.get() {
        return Ok(env);
    }
    let dll = find_ort_dll()?;
    let env = ort::init_from(&dll)
        .with_context(|| format!("加载 ONNX Runtime dll 失败: {}", dll.display()))?
        .with_name("Fabulous")
        .build()
        .context("初始化 ONNX Runtime 环境失败")?;
    // 并发下可能两个线程都走到这里，`set` 失败说明别人先放了，用它的。
    let _ = ORT_ENV.set(env);
    ORT_ENV.get().ok_or_else(|| anyhow::anyhow!("ONNX Runtime 环境初始化状态异常"))
}

/// 查找 `onnxruntime.dll`。
///
/// 优先级：
/// 1. 可执行文件同目录（打包后的正常位置，Tauri resource / 安装目录）
/// 2. 环境变量 `MUSICANAZ_ORT_DLL`（排查问题用）
/// 3. `CARGO_MANIFEST_DIR`（**仅开发期**有效，打包后是构建机路径）
fn find_ort_dll() -> Result<PathBuf> {
    let mut tried: Vec<String> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("onnxruntime.dll");
            if p.exists() {
                return Ok(p);
            }
            tried.push(p.display().to_string());
        }
    }

    if let Ok(p) = std::env::var("MUSICANAZ_ORT_DLL") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Ok(p);
        }
        tried.push(p.display().to_string());
    }

    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("onnxruntime.dll");
    if dev.exists() {
        return Ok(dev);
    }
    tried.push(dev.display().to_string());

    Err(anyhow::anyhow!(
        "找不到 onnxruntime.dll，已尝试:\n  {}",
        tried.join("\n  ")
    ))
}
impl BeatPredictor {

    /// 对整首 log-mel 谱做推理，返回逐帧 logits。
    ///
    /// `mel` 是 `(帧数, 128)` 的**行主序展平**数据。
    pub fn predict(&mut self, mel: &[f32], n_frames: usize) -> Result<BeatLogits> {
        self.predict_with_progress(mel, n_frames, &mut |_, _| {})
    }

    /// 带进度版本：`on(已完成块数, 总块数)`，每块一次。
    ///
    /// 推理本身就是**分块**的（`split_starts`），正好可以在块之间报进度 ——
    /// 一首 5 分钟的歌约 10 块，每块几百毫秒到 1 秒，进度条能动起来。
    pub fn predict_with_progress(
        &mut self,
        mel: &[f32],
        n_frames: usize,
        on: &mut dyn FnMut(usize, usize),
    ) -> Result<BeatLogits> {
        assert_eq!(mel.len(), n_frames * N_MELS, "mel 长度与帧数不匹配");

        // 未覆盖的位置保持 -1000（Python 用 torch.full(-1000) 初始化）。
        // peak picking 用 sigmoid 后是 0，等于「肯定不是拍」。
        let mut beat = vec![-1000.0f32; n_frames];
        let mut downbeat = vec![-1000.0f32; n_frames];

        let starts = split_starts(n_frames, CHUNK_SIZE, BORDER);

        let total_chunks = starts.len();

        // keep_first：倒序处理，早的块最后写、覆盖晚的块（与 Python 一致）
        for (done, &start) in starts.iter().rev().enumerate() {
            let chunk = make_chunk(mel, n_frames, start, CHUNK_SIZE, BORDER);
            let (b, d) = self.run_one(&chunk)?;

            // 丢弃两侧 border 后写回
            let lo = (start + BORDER as i64).max(0) as usize;
            let hi = ((start + CHUNK_SIZE as i64 - BORDER as i64) as usize).min(n_frames);
            if lo >= hi {
                continue;
            }
            // chunk 里第 i 帧对应全局的 start + i
            let src_lo = (lo as i64 - start) as usize;
            beat[lo..hi].copy_from_slice(&b[src_lo..src_lo + (hi - lo)]);
            downbeat[lo..hi].copy_from_slice(&d[src_lo..src_lo + (hi - lo)]);

            on(done + 1, total_chunks);
        }

        Ok(BeatLogits { beat, downbeat })
    }

    /// 单块前向。输入是 `(1, T, 128)` 的展平数据，输出是长度 T 的两条 logits。
    fn run_one(&mut self, chunk: &[f32]) -> Result<(Vec<f32>, Vec<f32>)> {
        let t = chunk.len() / N_MELS;
        let input = Tensor::from_array(([1usize, t, N_MELS], chunk.to_vec()))?;

        let outputs = self
            .session
            .run(ort::inputs![input])?;

        let (_, beat) = outputs[0].try_extract_tensor::<f32>()?;
        let (_, downbeat) = outputs[1].try_extract_tensor::<f32>()?;

        Ok((beat.to_vec(), downbeat.to_vec()))
    }
}

/// 复刻 `split_piece` 的 start 计算。
///
/// ```
/// starts = arange(-border, n - border, chunk - 2*border)
/// if avoid_short_end and n > chunk - 2*border:
///     starts[-1] = n - (chunk - border)
/// ```
///
/// `avoid_short_end` 的作用：不让最后一块太短（太短的块预测质量差），
/// 代价是它和前一块的重叠会超过 `border` —— 靠 `keep_first` 解决。
pub fn split_starts(n: usize, chunk: usize, border: usize) -> Vec<i64> {
    let step = (chunk - 2 * border) as i64;
    let mut starts: Vec<i64> = Vec::new();
    let mut s = -(border as i64);
    while s < n as i64 - border as i64 {
        starts.push(s);
        s += step;
    }
    if starts.is_empty() {
        // 极端短音频：Python 的 arange 在这种情况下也会给一个元素
        starts.push(-(border as i64));
    } else if n > chunk - 2 * border {
        let last = starts.len() - 1;
        starts[last] = n as i64 - (chunk - border) as i64;
    }
    starts
}

/// 造一块数据，越界补 0 —— `zeropad` 的精确等价物。
///
/// # ⚠️ 补到多长很关键
///
/// 一开始我写成「一律补满 chunk_size」，看起来更整齐，但**是错的**：
/// 12 秒的音频（601 帧）Python 只补到 **613 帧**，我却补到 1500 帧。
/// 模型的 T 是动态的，多出来的 893 帧会让 RoPE 的位置编码和注意力范围
/// 全变，logits 直接跑偏。
///
/// Python 的原式是：
/// ```text
/// zeropad(spect[max(start,0) : min(start+chunk, n)],
///         left  = max(0, -start),
///         right = max(0, min(border, start + chunk - n)))
/// ```
/// 也就是总长 = `slice_len + left + right`，**不是** `chunk_size`。
fn make_chunk(
    mel: &[f32],
    n_frames: usize,
    start: i64,
    chunk_size: usize,
    border: usize,
) -> Vec<f32> {
    let from = start.max(0) as usize;
    let to = ((start + chunk_size as i64) as usize).min(n_frames);
    let left = (start.min(0).abs()) as usize;
    let right = (border as i64).min(start + chunk_size as i64 - n_frames as i64).max(0) as usize;

    let total = (to - from) + left + right;
    let mut out = vec![0.0f32; total * N_MELS];
    if from < to {
        out[left * N_MELS..(left + (to - from)) * N_MELS]
            .copy_from_slice(&mel[from * N_MELS..to * N_MELS]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_for_short_piece_is_single_chunk() {
        // 601 帧 < 1500-12，只有一块，start = -6（和 Python 实测一致）
        assert_eq!(split_starts(601, 1500, 6), vec![-6]);
    }

    #[test]
    fn starts_for_long_piece_avoid_short_end() {
        // Python 实测：1803 帧 → starts = [-6, 309]
        assert_eq!(split_starts(1803, 1500, 6), vec![-6, 309]);
    }

    #[test]
    fn short_piece_chunk_is_613_frames_like_python() {
        // Python 实测：601 帧 → zeropad 后 613 帧（左 6 + 右 6）
        let n = 601;
        let mel = vec![1.0f32; n * N_MELS];
        let c = make_chunk(&mel, n, -6, 1500, 6);
        assert_eq!(c.len() / N_MELS, 613);
    }

    #[test]
    fn long_piece_chunks_are_full_1500() {
        // 1803 帧两块：start=-6 → 1500 帧；start=309 → 1500 帧
        let n = 1803;
        let mel = vec![1.0f32; n * N_MELS];
        assert_eq!(make_chunk(&mel, n, -6, 1500, 6).len() / N_MELS, 1500);
        assert_eq!(make_chunk(&mel, n, 309, 1500, 6).len() / N_MELS, 1500);
    }

    #[test]
    fn chunk_pads_left_with_zeros() {
        let n = 601;
        let mel = vec![1.0f32; n * N_MELS];
        let c = make_chunk(&mel, n, -6, 1500, 6);
        // 前 6 帧全是 0 padding
        assert!(c[..6 * N_MELS].iter().all(|&v| v == 0.0));
        // 第 7 帧开始是真实数据
        assert!(c[6 * N_MELS..7 * N_MELS].iter().all(|&v| v == 1.0));
    }

    // ── 与 Python 逐值对齐（需要 neural/exported/beat_this_final.onnx）──

    fn model_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../neural/exported/beat_this_final.onnx")
    }

    fn golden_mel() -> (Vec<f32>, usize) {
        static B: &[u8] = include_bytes!("../../assets/golden_mel.f32");
        let v: Vec<f32> = B
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        let n = v.len() / N_MELS;
        (v, n)
    }

    fn read_f32(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    /// 短音频（601 帧，单块）：Rust 的 logits 必须和 Python ONNX 一致。
    #[test]
    fn logits_match_python_single_chunk() {
        let p = model_path();
        if !p.exists() {
            eprintln!("跳过：模型不存在 {}", p.display());
            return;
        }
        let (mel, n) = golden_mel();
        let expected_beat = read_f32(include_bytes!("../../assets/golden_beat_logits.f32"));
        let expected_down = read_f32(include_bytes!("../../assets/golden_downbeat_logits.f32"));

        let mut pred = BeatPredictor::load(&p).unwrap();
        let out = pred.predict(&mel, n).unwrap();

        assert_eq!(out.beat.len(), n);
        let mb = out
            .beat
            .iter()
            .zip(&expected_beat)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        let md = out
            .downbeat
            .iter()
            .zip(&expected_down)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        println!("logits 最大误差 beat={mb:.6} downbeat={md:.6}");
        assert!(mb < 1e-3, "beat logits 误差过大: {mb}");
        assert!(md < 1e-3, "downbeat logits 误差过大: {md}");
    }

    /// 长音频（1803 帧，两块）：验证分块 + keep_first 聚合的正确性。
    #[test]
    fn logits_match_python_after_chunking() {
        let p = model_path();
        if !p.exists() {
            eprintln!("跳过：模型不存在 {}", p.display());
            return;
        }
        let (mel12, n12) = golden_mel();
        // 拼 3 倍取 1803 帧，和生成 golden 的脚本一致
        let n = 1803;
        let mut mel = Vec::with_capacity(n * N_MELS);
        for i in 0..n {
            let src = (i % n12) * N_MELS;
            mel.extend_from_slice(&mel12[src..src + N_MELS]);
        }
        let expected_beat =
            read_f32(include_bytes!("../../assets/golden_beat_logits_long.f32"));
        let expected_down =
            read_f32(include_bytes!("../../assets/golden_downbeat_logits_long.f32"));

        let mut pred = BeatPredictor::load(&p).unwrap();
        let out = pred.predict(&mel, n).unwrap();

        let mb = out
            .beat
            .iter()
            .zip(&expected_beat)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        let md = out
            .downbeat
            .iter()
            .zip(&expected_down)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        println!("分块 logits 最大误差 beat={mb:.6} downbeat={md:.6}");
        assert!(mb < 1e-3, "分块 beat logits 误差过大: {mb}");
        assert!(md < 1e-3, "分块 downbeat logits 误差过大: {md}");
    }
}
