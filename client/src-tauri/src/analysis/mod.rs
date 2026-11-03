//! Rust 侧完整分析链：音频文件 → 与 `analysis.json` 同构的产物。
//!
//! # 链路
//!
//! ```text
//! decode ─► resample 22050 ─► estimate_tuning ─┬─► log-mel ─► beat_this ─► postprocess
//!                                              │                              │
//!                                              │                    dedupe + detect_meter
//!                                              │                              │
//!                                              │                    rebuild_beats_from_downbeats
//!                                              │
//!                                              ├─► hybrid_cqt(tuning) ─► ChordNet ×5 ─► median ─► XHMM
//!                                              │
//!                                              └─► chroma_cqt + rms ─► SSM ─► Foote ─► KMeans
//!                                                                                  │
//!                                             finalize（拍号 / BPM / 速度段 / 补漏检）
//! ```
//!
//! # 和 Python 侧的一处**刻意不同**：不做 audio pitch-shift
//!
//! `analyze_song.py` 检测到调音偏差后会生成一份 pitch_shift 过的临时音频，
//! 后续所有模型都跑那份。Rust 侧改为**把偏差直接传给 CQT**（`hybrid_cqt(y, tuning)`），
//! 两种做法在数学上等价（`librosa.cqt` 内部就是 `fmin * 2^(tuning/bpo)`），
//! 但省掉一次整曲重采样 + 相位声码器，也避免了 pitch-shift 的瞬态涂抹。
//!
//! 拍点检测（log-mel）本来就不受几十音分的影响，所以不需要校正。

pub mod grid;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::audio;
use crate::model;

// ─────────────────────────── 输出结构（与 analysis.json 同构） ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongInfo {
    pub title: String,
    pub artist: String,
    pub duration_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub beats: String,
    pub chords: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterInfo {
    pub numerator: usize,
    pub denominator: usize,
    #[serde(default)]
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoSegment {
    pub start_bar: usize,
    pub end_bar: usize,
    pub bpm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordAlternative {
    pub chord: String,
    pub prob: f32,
    /// `None` = 来自 lv-chordia 自己的概率分布；`Some("madmom")` = 第二引擎补的。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordSegment {
    pub start: f64,
    pub end: f64,
    pub chord: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<ChordAlternative>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSegment {
    pub label: String,
    /// 读老数据时要容忍 `{start, end}`（秒）那种格式 —— 缺失就落到 0，
    /// 反正前端 `normalizeSections` 两种都认。
    #[serde(default)]
    pub start_bar: usize,
    #[serde(default)]
    pub end_bar: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningInfo {
    /// 实测偏差（音分，负 = 偏低）
    pub deviation_cents: f64,
    /// Rust 侧**不做** audio pitch-shift，这个字段恒为 false ——
    /// 偏差已在 CQT 阶段以 `tuning` 参数吸收。
    pub corrected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub beats_per_bar: usize,
    /// 老数据没有这个字段（那时 meta 里只有 beatsPerBar），所以必须可选。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meter: Option<MeterInfo>,
    /// BPM 是**四分音符每分钟**，按小节间隔算（与拍号解耦）。
    pub bpm_median: f64,
    #[serde(default)]
    pub bpm_raw_beats: f64,
    #[serde(default)]
    pub bpm_raw_bars: f64,
    #[serde(default)]
    pub beat_scale: f64,
    pub bar_sec_median: f64,
    #[serde(default)]
    pub beat_sec_median: f64,
    pub beat_count: usize,
    pub bar_count: usize,
}

/// 完整分析产物。字段顺序与 `analysis.json` 一致，前端直接消费。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub song: SongInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceInfo>,
    pub downbeats_sec: Vec<f64>,
    pub beats_sec: Vec<f64>,
    /// key 是词表档位（`submission` / `ismir2017` / `full`）。
    pub chords: std::collections::BTreeMap<String, Vec<ChordSegment>>,
    #[serde(default)]
    pub sections: Vec<SectionSegment>,
    #[serde(default)]
    pub tempo_segments: Vec<TempoSegment>,
    pub meta: Meta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meter: Option<MeterInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuning: Option<TuningInfo>,
}

// ─────────────────────────── 进度回调 ───────────────────────────

/// 分析阶段（前端按这个字段决定进度条文案）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Probe,
    Tuning,
    Beats,
    Chords,
    Structure,
    Assemble,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Probe => "probe",
            Stage::Tuning => "tuning",
            Stage::Beats => "beats",
            Stage::Chords => "chords",
            Stage::Structure => "structure",
            Stage::Assemble => "assemble",
        }
    }
}

/// 进度回调：`(阶段, 0~1 进度, 文案)`。
pub type ProgressFn<'a> = &'a mut dyn FnMut(Stage, f64, &str);

/// 阶段性结果回调：`(阶段, 当前已知的全部内容)`。
///
/// 分析是分阶段的（拍点 → 和弦 → 结构），每段结束都能给出一份**完整且合法**
/// 的分析 JSON。带上它前端就能边分析边渲染，而不是盯着空白窗口等十几秒。
///
/// ## 为什么传字符串而不是 `&Analysis`
///
/// 前端消费的就是 JSON 字符串（`currentAnalysis` 直接 `JSON.parse`），
/// 这里序列化一次，上层不用再包一层。也避免中途结构体被借用着不能改。
pub type PartialFn<'a> = &'a mut dyn FnMut(Stage, String);

// ─────────────────────────── 模型路径 ───────────────────────────

/// 模型与词表的路径。打包后由 Tauri resource 提供。
pub struct ModelPaths {
    /// `beat_this_final.onnx`（约 83 MB）
    pub beat: PathBuf,
    /// 5 折和弦模型所在目录（`chord_fold0..4.onnx`）
    pub chord_dir: PathBuf,
}

impl ModelPaths {
    /// 开发期默认布局：`neural/exported/` + `src-tauri/assets/`。
    ///
    /// 可用环境变量覆盖：
    /// - `MUSICANAZ_BEAT_MODEL` —— beat_this ONNX 的完整路径
    /// - `MUSICANAZ_ASSETS_DIR` —— 资产目录（`resolve_asset` 也认这个）
    pub fn discover() -> Result<Self> {
        // 统一走 `model::resolve_asset` 的查找顺序：
        //
        // ```text
        // ① exe 同目录            ← 打包后（Tauri resources 落到这里）
        // ② exe 同目录/assets     ← 打包后（若资源放在 assets/ 子目录）
        // ③ MUSICANAZ_ASSETS_DIR  ← 用户自定义
        // ④ CARGO_MANIFEST_DIR/assets  ← 开发期兜底
        // ```
        //
        // beat 模型不在 `assets/` 下（它在 `neural/exported/`），所以额外试一次
        // 开发期路径 —— 那是唯一一个「不在 assets 目录里」的资产。
        let beat = if let Ok(p) = std::env::var("MUSICANAZ_BEAT_MODEL") {
            PathBuf::from(p)
        } else {
            let mut found = crate::model::resolve_asset("beat_this_final.onnx").ok();
            if found.is_none() {
                let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../neural/exported/beat_this_final.onnx");
                if dev.exists() {
                    found = Some(dev);
                }
            }
            found.ok_or_else(|| {
                anyhow::anyhow!("找不到 beat_this 模型（设 MUSICANAZ_BEAT_MODEL 指定路径）")
            })?
        };

        // 和弦模型目录 = 找到的 `chord_fold0.onnx` 的父目录。
        // 这样打包后（exe 同目录或 assets/）和开发期都自动对。
        let chord_dir = crate::model::resolve_asset("chord_fold0.onnx")
            .context("找不到和弦模型 chord_fold0.onnx（5 折都要在同一目录）")?
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| anyhow::anyhow!("和弦模型路径没有父目录"))?;

        Ok(Self { beat, chord_dir })
    }
}

// ─────────────────────────── 步骤 ───────────────────────────

/// 拍点步骤的结果。
pub struct BeatGrid {
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub meter: MeterInfo,
}

/// 只跑拍点步骤（解码 → 重采样 → log-mel → beat_this → 后处理 → 重建网格）。
///
/// 单独暴露出来便于「只重测拍点」这类操作，也便于和 Python 逐段对比。
pub fn analyze_beats(
    samples_22k: &[f32],
    duration: f64,
    beat_model: &Path,
) -> Result<BeatGrid> {
    analyze_beats_with_progress(samples_22k, duration, beat_model, &mut |_, _| {})
}

/// 带进度的拍点识别。`on(已完成块, 总块)` 由 `BeatPredictor` 的分块推理驱动。
pub fn analyze_beats_with_progress(
    samples_22k: &[f32],
    duration: f64,
    beat_model: &Path,
    on: &mut dyn FnMut(usize, usize),
) -> Result<BeatGrid> {
    let mel = audio::mel::log_mel_spectrogram(samples_22k);
    let n_frames = mel.len();
    anyhow::ensure!(n_frames > 0, "音频太短，算不出 mel 谱");

    // 展平成 (帧数, 128) 的行主序
    let mut flat = Vec::with_capacity(n_frames * audio::mel::N_MELS);
    for row in &mel {
        flat.extend_from_slice(row);
    }

    let mut predictor = model::beat::BeatPredictor::load(beat_model)?;
    let logits = predictor.predict_with_progress(&flat, n_frames, on)?;
    let peaks = model::postprocess::postprocess(&logits.beat, &logits.downbeat);

    let beats: Vec<f64> = peaks.beats.iter().map(|v| *v as f64).collect();
    let downs: Vec<f64> = peaks.downbeats.iter().map(|v| *v as f64).collect();

    // 小节交界处的假拍：beat_this 会挤出 0.20~0.22s 的拍（真实间隔 0.42s）
    let beats = grid::dedupe(&beats, 0.25);
    let downs = grid::dedupe(&downs, 1.0);
    anyhow::ensure!(!downs.is_empty(), "没有检出任何小节");

    // ⚠️ 拍号必须在重建**之前**检测：重建会按固定拍数均分，
    // 一旦猜错就再也看不出来了（6/8 被压成 4/4 之后原始拍间隔永久消失）。
    let (num, den, conf, _votes) = grid::detect_meter(&beats, &downs);
    let (beats, downs) = grid::rebuild_beats_from_downbeats(&beats, &downs, num, duration);

    Ok(BeatGrid {
        beats,
        downbeats: downs,
        meter: MeterInfo {
            numerator: num,
            denominator: den,
            confidence: conf,
        },
    })
}

// ─────────────────────────── finalize ───────────────────────────

/// 舍入到小数点后 n 位。
fn round_n(v: f64, n: u32) -> f64 {
    let f = 10f64.powi(n as i32);
    (v * f).round() / f
}

/// finalize 的产物。
pub struct Finalized {
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub tempo_segments: Vec<TempoSegment>,
    pub meta: Meta,
}

/// 补全 meta、速度段，并做最后的 half-time 修正。
///
/// 与 `build_analysis_json.py` 同一套判定（两个脚本必须给出同一个 BPM，
/// 否则用户在两条路之间切换会看到 BPM 变了）。
pub fn finalize(beats: &[f64], downbeats: &[f64], meter: &MeterInfo) -> Finalized {
    let num = if meter.numerator == 0 { 4 } else { meter.numerator };
    let den = if meter.denominator == 0 { 4 } else { meter.denominator };
    let quarters_per_bar = num as f64 * 4.0 / den as f64;

    if downbeats.len() < 3 {
        return Finalized {
            beats: beats.iter().map(|v| round_n(*v, 4)).collect(),
            downbeats: downbeats.iter().map(|v| round_n(*v, 4)).collect(),
            tempo_segments: Vec::new(),
            meta: Meta {
                beats_per_bar: num,
                meter: Some(MeterInfo {
                    numerator: num,
                    denominator: den,
                    confidence: 0.0,
                }),
                bpm_median: 0.0,
                bpm_raw_beats: 0.0,
                bpm_raw_bars: 0.0,
                beat_scale: 1.0,
                bar_sec_median: 0.0,
                beat_sec_median: 0.0,
                beat_count: beats.len(),
                bar_count: downbeats.len(),
            },
        };
    }

    // ---- 先记下「补全之前」的基线与原始 BPM ----
    let raw_beat_ioi = if beats.len() > 1 { grid::median(&grid::diff(beats)) } else { 0.0 };
    let raw_bar_ioi = grid::median(&grid::diff(downbeats));

    // ---- 补全局部漏检（间隔是基础间隔整数倍时插点）----
    let (downbeats, _add_d) = grid::fill_half_time_gaps(downbeats, 0.25);
    let (beats, _add_b) = grid::fill_half_time_gaps(beats, 0.25);

    // ---- 修**整体** half-time ----
    //
    // 不做这一步会出现：一小节里只标了 2 拍，前端拍网格与小节网格差一倍，
    // 结构段（按小节画）和和弦（按拍画）整体错位。
    let beat_scale = grid::beat_scale_for_beats(&downbeats, &beats, num);
    let beats = if beat_scale != 1.0 {
        grid::rescale_times(&beats, beat_scale)
    } else {
        beats
    };

    // ---- BPM：四分音符每分钟，与拍号解耦 ----
    //
    // 6/8 一小节 3 个四分音符、一小节 1.90s → 3/1.90*60 = 94.7
    // （写死 4 就成了 126.3，用户看到的「BPM 整体快了 3/4」）
    let bar_secs = grid::diff(&downbeats);
    let bar_bpm: Vec<f64> = bar_secs.iter().map(|s| quarters_per_bar / s * 60.0).collect();
    let med_bpm = grid::median(&bar_bpm);

    // ---- 速度段（阈值 5%，吸收补全引入的抖动）----
    const SEG_THRESHOLD: f64 = 0.05;
    let mut segments: Vec<TempoSegment> = Vec::new();
    let mut i = 0usize;
    let n = bar_bpm.len();
    while i < n {
        let mut j = i;
        let mut vals = vec![bar_bpm[i]];
        while j + 1 < n {
            if (bar_bpm[j + 1] - vals[0]).abs() / vals[0] >= SEG_THRESHOLD {
                break;
            }
            j += 1;
            vals.push(bar_bpm[j]);
        }
        segments.push(TempoSegment {
            start_bar: i,
            end_bar: j + 1,
            bpm: round_n(grid::median(&vals), 2),
        });
        i = j + 1;
    }

    // ---- 合并：相邻 BPM 接近 或 单小节段 ----
    let mut merged: Vec<TempoSegment> = Vec::new();
    for seg in segments {
        let should_merge = merged.last().is_some_and(|prev| {
            (seg.end_bar - seg.start_bar) <= 1
                || (seg.bpm - prev.bpm).abs() / prev.bpm < 0.04
        });
        if should_merge {
            let prev = merged.last_mut().unwrap();
            prev.end_bar = seg.end_bar;
            let lo = prev.start_bar;
            let hi = prev.end_bar.min(bar_bpm.len());
            if hi > lo {
                prev.bpm = round_n(grid::median(&bar_bpm[lo..hi]), 2);
            }
        } else {
            merged.push(seg);
        }
    }

    let bar_sec_median = grid::median(&bar_secs);
    let beat_sec_median = if beats.len() > 1 { grid::median(&grid::diff(&beats)) } else { 0.0 };

    // 一拍是 1/den 全音符 → 四分音符时长 = 拍时长 × den/4
    let bpm_raw_beats = if raw_beat_ioi > 0.0 {
        round_n(60.0 / (raw_beat_ioi * den as f64 / 4.0), 2)
    } else {
        0.0
    };
    let bpm_raw_bars = if raw_bar_ioi > 0.0 {
        round_n(quarters_per_bar * 60.0 / raw_bar_ioi, 2)
    } else {
        0.0
    };

    Finalized {
        beats: beats.iter().map(|v| round_n(*v, 4)).collect(),
        downbeats: downbeats.iter().map(|v| round_n(*v, 4)).collect(),
        tempo_segments: merged,
        meta: Meta {
            beats_per_bar: num,
            meter: Some(MeterInfo {
                numerator: num,
                denominator: den,
                confidence: round_n(meter.confidence, 3),
            }),
            bpm_median: round_n(med_bpm, 2),
            bpm_raw_beats,
            bpm_raw_bars,
            beat_scale,
            bar_sec_median: round_n(bar_sec_median, 4),
            beat_sec_median: round_n(beat_sec_median, 4),
            beat_count: beats.len(),
            bar_count: downbeats.len(),
        },
    }
}

/// 从文件名猜「Artist - Title」。
fn split_stem(path: &Path) -> (String, String) {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match stem.split_once(" - ") {
        Some((artist, title)) => (title.trim().to_string(), artist.trim().to_string()),
        None => (stem, String::new()),
    }
}

// ─────────────────────────── 完整链 ───────────────────────────

/// 词表档位。`submission` 是 lv-chordia 论文提交用的那套（301 状态，最常用）。
pub const DEFAULT_VOCAB: &str = "submission";

/// 跑完整分析链。
///
/// `progress` 会在每个阶段开头被调用一次，文案直接给用户看。
///
/// 只要进度、不要阶段性结果时用这个（测试、批处理）。
pub fn analyze_file(path: &Path, models: &ModelPaths, progress: ProgressFn) -> Result<Analysis> {
    analyze_file_with(path, models, progress, &mut |_, _| {})
}
/// 完整版：额外在「拍点」「和弦」「结构」三个阶段结束时各推一份中间结果。
pub fn analyze_file_with(
    path: &Path,
    models: &ModelPaths,
    progress: ProgressFn,
    on_partial: PartialFn,
) -> Result<Analysis> {
    progress(Stage::Probe, 0.01, "读取音频…");
    let decoded = {
        // 解码是逐 packet 的，能报真实百分比。以前这一段完全没有回调，
        // 用户盯着一句静态的「读取音频…」等好几秒。
        let mut cb = |f: f32| {
            progress(
                Stage::Probe,
                0.01 + f as f64 * 0.07,
                &format!("读取音频… {}%", (f * 100.0).round() as i32),
            );
        };
        audio::decode::decode_to_mono_f32_with_progress(path, &mut cb)
            .with_context(|| format!("解码失败: {}", path.display()))?
    };
    let duration = decoded.duration_sec();
    anyhow::ensure!(duration > 1.0, "音频太短（{duration:.2}s）");

    let (title, artist) = split_stem(path);

    // ---- 重采样到 22050（所有模型都按这个采样率训练）----
    progress(Stage::Probe, 0.09, "重采样到 22.05 kHz…");
    let y = if decoded.sample_rate == audio::ANALYSIS_SAMPLE_RATE {
        decoded.samples
    } else {
        audio::resample::resample_mono(
            &decoded.samples,
            decoded.sample_rate,
            audio::ANALYSIS_SAMPLE_RATE,
        )?
    };
    anyhow::ensure!(!y.is_empty(), "重采样后没有样本");

    // ---- 0. 调音偏差（必须在所有模型之前）----
    //
    // 实测《満ちてゆく》整体偏低 34.7 音分。不校正的后果：
    // lv-chordia 判 N 的总时长 33.7s（10.7%）→ 校正后只剩 8.6s（2.7%）。
    progress(Stage::Tuning, 0.10, "检测调音偏差…");
    // ---- ⚠️ 必须用**粗粒度**（bpo=12）估，不能直接用 CQT 的 bpo=36 ----
    //
    // `pitch_tuning` 把残差折进 [0,1) 的一维直方图再取峰。bpo 越大桶越窄，
    // 真实的 -34.7 音分在 bpo=36 下是 -1.04 bin，取模后跑到 +0.96 bin，
    // 直方图峰被别的音符挤偏 —— 实测同一首歌：
    //
    // ```text
    // bpo=12 → -34.00 音分   （与 CQT 谱峰 -33.3、HPSS 谐波峰 -34.8 一致）
    // bpo=24 → +16.90 音分
    // bpo=36 →  +1.53 音分   ← 直接拿它当 tuning 喂 CQT 就错了
    // bpo=48 →  -8.96 音分
    // ```
    //
    // 只有 bpo=12（半音粒度，桶宽 100 音分 > 常见偏差）不会混叠。
    // Python 的 `detect_tuning` 用的也是默认的 bpo=12，两边才对得上。
    const TUNING_BPO: u32 = 12;
    let tuning12 = audio::tuning::estimate_tuning(
        &y,
        audio::ANALYSIS_SAMPLE_RATE as f32,
        TUNING_BPO,
    );
    // 换成 CQT 的 bin 单位：t12 的单位是「半音」，CQT 用「1/36 八度」，
    // 1 个半音 = 3 个 1/36 八度 —— 乘 3，不是除 3。
    let tuning_bins = tuning12 * (audio::cqt::BPO as f32 / TUNING_BPO as f32);
    let deviation_cents = tuning12 as f64 * 1200.0 / TUNING_BPO as f64;
    progress(
        Stage::Tuning,
        0.13,
        &format!("调音偏差 {deviation_cents:+.0} 音分"),
    );

    // ---- 1. 拍点 ----
    // mel 谱是一整段并行算的（rayon），内部没有可插的点；
    // 但它比推理快得多，报一次文案足够让用户知道在动。
    progress(Stage::Beats, 0.14, "计算 log-mel 谱…");
    progress(Stage::Beats, 0.18, "识别拍点与小节…");
    let beat_grid = {
        // 分块推理：一首 5 分钟的歌约 10 块，每块 0.3~1s
        let mut cb = |done: usize, total: usize| {
            let f = if total == 0 { 1.0 } else { done as f64 / total as f64 };
            progress(
                Stage::Beats,
                0.18 + f * 0.26,
                &format!("识别拍点… {done}/{total} 块"),
            );
        };
        analyze_beats_with_progress(&y, duration, &models.beat, &mut cb)?
    };
    // 拍点一出来就定稿 BPM / meta / 速度段：`finalize` 里的 half-time 修正
    // 也可能改动 beats，所以后面所有地方（结构分析、推送、最终产物）都必须
    // 用 `fin` 这一份，不能再用 `beat_grid` 的原值。
    let fin = finalize(&beat_grid.beats, &beat_grid.downbeats, &beat_grid.meter);
    progress(
        Stage::Beats,
        0.46,
        &format!(
            "检出 {} 拍 / {} 小节（{}/{}）",
            fin.beats.len(),
            fin.downbeats.len(),
            beat_grid.meter.numerator,
            beat_grid.meter.denominator
        ),
    );

    // 边算边填：每完成一段就推一份**完整且合法**的 JSON，前端可以立刻画出来。
    // 字段顺序与最终产物一致，所以前端解析逻辑只写一套。
    let mut out = Analysis {
        song: SongInfo {
            title,
            artist,
            duration_sec: round_n(duration, 4),
        },
        source: Some(SourceInfo {
            beats: "beat_this (onnx)".into(),
            chords: "lv-chordia (onnx ×5)".into(),
            note: "rust native pipeline".into(),
        }),
        downbeats_sec: fin.downbeats.clone(),
        beats_sec: fin.beats.clone(),
        chords: Default::default(),
        sections: Vec::new(),
        tempo_segments: fin.tempo_segments.clone(),
        meta: fin.meta.clone(),
        meter: Some(MeterInfo {
            numerator: beat_grid.meter.numerator,
            denominator: beat_grid.meter.denominator,
            confidence: round_n(beat_grid.meter.confidence, 3),
        }),
        tuning: Some(TuningInfo {
            deviation_cents: round_n(deviation_cents, 1),
            corrected: false,
            reason: Some("CQT 阶段以 tuning 参数吸收，未做音频 pitch-shift".into()),
        }),
    };
    on_partial(Stage::Beats, serde_json::to_string(&out)?);

    // ---- 2. 和弦 ----
    progress(Stage::Chords, 0.48, "计算 CQT 特征…");
    let cqt = audio::cqt::hybrid_cqt(&y, tuning_bins);
    progress(Stage::Chords, 0.62, "加载和弦模型…");
    let mut chord_model = model::chord::ChordPredictor::load_from_dir(&models.chord_dir)?;
    progress(Stage::Chords, 0.64, "识别和弦（5 折推理）…");
    let probs = {
        // 5 折串行，每折一次整段推理 —— 一折一层进度，别让条子死住
        let mut cb = |done: usize, total: usize| {
            let f = if total == 0 { 1.0 } else { done as f64 / total as f64 };
            progress(
                Stage::Chords,
                0.64 + f * 0.16,
                &format!("识别和弦… 第 {done}/{total} 折"),
            );
        };
        chord_model.predict_with_progress(&cqt.data, cqt.frames, &mut cb)?
    };
    progress(Stage::Chords, 0.82, "解码和弦序列（3 档词表）…");

    // 三档词表都解一遍：用户在检查器里切换档位不用等重算。
    // 三档加起来约 100 ms（Viterbi 是纯标量运算），不值得懒惰。
    let mut chords: std::collections::BTreeMap<String, Vec<ChordSegment>> = Default::default();
    for vocab in ["submission", "ismir2017", "full"] {
        let xhmm = model::xhmm::Xhmm::load(vocab)?;
        let segs = xhmm.decode(&probs, cqt.frames)?;
        progress(
            Stage::Chords,
            0.83 + (chords.len() as f64 + 1.0) / 3.0 * 0.04,
            &format!("解码和弦序列… {vocab}"),
        );
        chords.insert(
            vocab.to_string(),
            segs.into_iter()
                .map(|s| ChordSegment {
                    start: round_n(s.start, 4),
                    end: round_n(s.end, 4),
                    chord: s.chord,
                    confidence: Some(s.confidence),
                    alternatives: Some(
                        s.alternatives
                            .into_iter()
                            .map(|(chord, prob)| ChordAlternative {
                                chord,
                                prob,
                                source: None,
                            })
                            .collect(),
                    ),
                })
                .collect(),
        );
    }
    progress(Stage::Chords, 0.87, "和弦识别完成");
    out.chords = chords;
    on_partial(Stage::Chords, serde_json::to_string(&out)?);

    // ---- 2c. 刻意**不**做「用和弦边界校正倍速」这一步 ----
    //
    // Python 侧有个 `_pick_best_scale`：拿和弦起点到最近拍点的中位偏移，
    // 在两套网格（当前 / 每两拍插一拍）之间投票。这里不移植，三个理由：
    //
    // 1. **它必然无效**。那个函数只插 `beats`、不动 `downbeats`，插完
    //    「每小节拍数」就翻倍了，`finalize` 里的 `beat_scale_for_beats`
    //    会立刻按 downbeats 把它缩回去（实测 413 → 825 → 413）。
    // 2. **判据会误伤反拍多的歌**。插拍后网格变密，和弦离最近拍点只会更近，
    //    所以在本来就正确的网格上也会险胜（实测《満ちてゆく》6:5）。
    // 3. 真正该负责这件事的是 `beat_scale_for_beats`：它用 downbeats/beats
    //    的比例判断，插拍后会保持自洽（ratio 恒等于拍号分子）。
    //
    // 《満ちてゆく》实测：Rust BPM 72.29 == Python 72.29，说明不移植也不会
    // 把拍速判错。
    // ---- 3. 结构 ----
    //
    // 用的不是和弦标签，而是音频本身的 chroma + RMS：和弦标签的区分度太低
    // （主歌和副歌常常是同一套和弦进行）。
    progress(Stage::Structure, 0.88, "计算 chroma / 能量包络…");
    let (chroma_frames, chroma) = audio::chroma::chroma_cqt(&y);
    let (rms_frames, rms) = audio::chroma::rms(&y);
    progress(Stage::Structure, 0.92, "分析歌曲结构（自相似矩阵）…");
    let struct_segs = model::structure::analyze(
        &chroma,
        chroma_frames,
        &rms,
        rms_frames,
        &fin.downbeats,
        duration,
    );
    let sections: Vec<SectionSegment> = struct_segs
        .iter()
        .map(|s| SectionSegment {
            label: s.label.clone(),
            start_bar: s.start_bar,
            end_bar: s.end_bar,
        })
        .collect();
    progress(
        Stage::Structure,
        0.97,
        &format!("识别出 {} 个段落", sections.len()),
    );

    // ---- 4. 收尾 ----
    //
    // BPM / meta / 速度段在拍点阶段就定稿了（见上面的 `finalize`），
    // 这里只补最后一段结构，然后推最后一份快照。
    out.sections = sections;
    on_partial(Stage::Structure, serde_json::to_string(&out)?);
    progress(Stage::Assemble, 1.0, "完成");

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试音频路径。
    ///
    /// `testdata/songs/*/audio.flac` **因版权已从仓库移除**（音乐是有版权的，
    /// 不适合随源码分发）。所以这里可能拿不到音频：
    ///
    ///   - `MUSICANAZ_TEST_AUDIO=<path>` 指定任意一首歌（推荐，测试只看行为不看具体曲目）
    ///   - 否则回退到 `testdata/songs/<dir>/audio.flac`（本地自备时才存在）
    ///
    /// 返回 `None` 时调用方直接 return —— 这些都是 `#[ignore]` 的手动排查工具，
    /// 资源缺失不该让它们失败（那只会让人以为代码坏了）。
    fn test_audio(dir: &str) -> Option<std::path::PathBuf> {
        let p = std::env::var("MUSICANAZ_TEST_AUDIO")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../testdata/songs")
                    .join(dir)
                    .join("audio.flac")
            });
        if p.is_file() {
            Some(p)
        } else {
            eprintln!(
                "跳过：找不到测试音频 {}（testdata 音频因版权未入库，可用 MUSICANAZ_TEST_AUDIO 指定）",
                p.display()
            );
            None
        }
    }

    /// 打印两个时刻序列的**第一处分叉**，用于定位「拍数/小节数不一致」。
    ///
    /// 只看时刻不看数量：数量不同时，先找第一条对不上的位置，就知道差异
    /// 是集中在开头（漏检）、中段（相位滑移）还是结尾。
    fn find_divergence(name: &str, py: &[f64], rs: &[f64]) {
        const TOL: f64 = 0.05;
        let n = py.len().min(rs.len());
        for i in 0..n {
            if (py[i] - rs[i]).abs() > TOL {
                println!("\n{name} 第一处分叉 i={i}: python {:.3} vs rust {:.3}（共 py {} / rs {}）", py[i], rs[i], py.len(), rs.len());
                let lo = i.saturating_sub(3);
                for k in lo..(i + 6).min(n) {
                    println!("    [{k}] py {:.3}  rs {:.3}", py[k], rs[k]);
                }
                return;
            }
        }
        if py.len() == rs.len() {
            println!("\n{name} 逐项一致（{} 个）", py.len());
        } else {
            println!("\n{name} 前 {n} 项一致，但长度不同（py {} / rs {}）", py.len(), rs.len());
        }
    }

    /// 把 Rust 解码 + 重采样后的波形导出去，供 Python 在同一份数据上算 golden。
    ///
    /// 有了它才能把「long-CQT 是否漂移」和「decode/resample 是否不同」分开查。
    #[test]
    #[ignore = "排查工具，手动运行"]
    fn dump_wave60() {
        let Some(p) = test_audio("03-tokuni-nai") else {
            return;
        };
        let d = audio::decode::decode_to_mono_f32(&p).unwrap();
        let y = audio::resample::resample_mono(
            &d.samples,
            d.sample_rate,
            audio::ANALYSIS_SAMPLE_RATE,
        )
        .unwrap();
        let n = (60.0 * audio::ANALYSIS_SAMPLE_RATE as f64) as usize;
        let cut = &y[..n.min(y.len())];
        let bytes: Vec<u8> = cut.iter().flat_map(|v| v.to_le_bytes()).collect();
        let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/golden_wave60.f32");
        std::fs::write(&out, &bytes).unwrap();
        println!("wrote {} ({} samples, {:.3}s)", out.display(), cut.len(), cut.len() as f64 / 22050.0);
    }
    #[test]
    fn round_n_truncates_like_python_round() {
        assert_eq!(round_n(1.23456, 4), 1.2346);
        assert_eq!(round_n(1.0, 4), 1.0);
        assert_eq!(round_n(72.285, 2), 72.29);
    }

    #[test]
    fn split_stem_handles_artist_dash_title() {
        let (t, a) = split_stem(Path::new("E:/music/贝贝Beibo - 海蓝色圆舞曲.flac"));
        assert_eq!(t, "海蓝色圆舞曲");
        assert_eq!(a, "贝贝Beibo");
    }

    #[test]
    fn split_stem_without_dash() {
        let (t, a) = split_stem(Path::new("/tmp/mysong.wav"));
        assert_eq!(t, "mysong");
        assert_eq!(a, "");
    }

    /// 小节数不足 3 时 meta 要给出可用的零值，不能让前端除零。
    #[test]
    fn finalize_handles_too_few_bars() {
        let fin = finalize(&[0.0, 0.5], &[0.0, 2.0], &MeterInfo {
            numerator: 4,
            denominator: 4,
            confidence: 0.0,
        });
        assert_eq!(fin.meta.bpm_median, 0.0);
        assert_eq!(fin.meta.bar_count, 2);
        assert!(fin.tempo_segments.is_empty());
    }

    /// 4/4 / 120 BPM：一小节 2s，BPM 必须正好 120。
    #[test]
    fn finalize_computes_bpm_from_bars() {
        let downs: Vec<f64> = (0..9).map(|i| 2.76 + i as f64 * 2.0).collect();
        let mut beats = Vec::new();
        for &d in &downs {
            for k in 0..4 {
                beats.push(d + k as f64 * 0.5);
            }
        }
        let fin = finalize(&beats, &downs, &MeterInfo {
            numerator: 4,
            denominator: 4,
            confidence: 1.0,
        });
        assert!((fin.meta.bpm_median - 120.0).abs() < 0.01, "{}", fin.meta.bpm_median);
        assert_eq!(fin.meta.beats_per_bar, 4);
        assert_eq!(fin.meta.beat_scale, 1.0);
    }

    /// 6/8：一小节 3 个四分音符、1.90s → 94.7 BPM（不是 126.3）。
    #[test]
    fn finalize_six_eight_bpm_uses_quarters() {
        let bar = 1.90;
        let downs: Vec<f64> = (0..9).map(|i| i as f64 * bar).collect();
        let mut beats = Vec::new();
        for &d in &downs {
            for k in 0..6 {
                beats.push(d + k as f64 * bar / 6.0);
            }
        }
        let fin = finalize(&beats, &downs, &MeterInfo {
            numerator: 6,
            denominator: 8,
            confidence: 1.0,
        });
        let expect = 3.0 * 60.0 / bar;
        assert!(
            (fin.meta.bpm_median - expect).abs() < 0.05,
            "{} vs {}",
            fin.meta.bpm_median,
            expect
        );
        assert_eq!(fin.meta.beats_per_bar, 6);
    }

    /// 速度段：整首匀速时应该只有一段，且覆盖全部小节。
    #[test]
    fn finalize_single_tempo_segment_for_steady_song() {
        let downs: Vec<f64> = (0..11).map(|i| i as f64 * 2.0).collect();
        let mut beats = Vec::new();
        for &d in &downs {
            for k in 0..4 {
                beats.push(d + k as f64 * 0.5);
            }
        }
        let fin = finalize(&beats, &downs, &MeterInfo {
            numerator: 4,
            denominator: 4,
            confidence: 1.0,
        });
        assert_eq!(fin.tempo_segments.len(), 1, "{:?}", fin.tempo_segments);
        assert_eq!(fin.tempo_segments[0].start_bar, 0);
        assert_eq!(fin.tempo_segments[0].end_bar, 10);
    }

    /// 真跑一首歌，和 Python 的 `analysis.json` 逐项对比。
    ///
    /// ```text
    /// cd client/src-tauri
    /// MUSICANAZ_TEST_SONG=03-tokuni-nai cargo test --lib \
    ///   analysis::tests::rust_pipeline_matches_python -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要 83MB 模型 + onnxruntime.dll，手动运行"]
    fn rust_pipeline_matches_python() {
        let dir = std::env::var("MUSICANAZ_TEST_SONG").unwrap_or_else(|_| "03-tokuni-nai".into());
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/songs").join(&dir);
        let Some(audio) = test_audio(&dir) else {
            return;
        };
        // 期望值默认是 testdata 里的 analysis.json。
        //
        // 但仓库里的 analysis.json 是**历史产物**：Python 侧改过 detect_meter、
        // 6/8 支持、_pick_best_scale 之后，老文件里的数值已经不是当前实现的输出。
        // 要复现当前 Python 行为时，用 `MUSICANAZ_TEST_EXPECT=<新跑出来的 json>` 覆盖。
        let expect_path = std::env::var("MUSICANAZ_TEST_EXPECT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| root.join("analysis.json"));
        let expect: Analysis = serde_json::from_str(
            &std::fs::read_to_string(&expect_path)
                .unwrap_or_else(|_| panic!("读不到 {}", expect_path.display())),
        )
        .expect("analysis.json 解析失败");

        let models = ModelPaths::discover().expect("模型路径不对");
        let t0 = std::time::Instant::now();
        let got = analyze_file(
            &audio,
            &models,
            &mut |stage, pct, msg| println!("[{:.0}%] {:?} {msg}", pct * 100.0, stage),
        )
        .expect("分析失败");
        println!("耗时 {:.1}s", t0.elapsed().as_secs_f64());

        println!("\n{:<18} {:>12} {:>12} {:>10}", "字段", "python", "rust", "差异");
        let cmp_usize = |name: &str, a: usize, b: usize| {
            println!("{:<18} {:>12} {:>12} {:>10}", name, a, b, b as i64 - a as i64);
        };
        let cmp_f64 = |name: &str, a: f64, b: f64| {
            println!("{:<18} {:>12.3} {:>12.3} {:>10.3}", name, a, b, b - a);
        };

        cmp_f64("bpmMedian", expect.meta.bpm_median, got.meta.bpm_median);
        cmp_usize("beats", expect.beats_sec.len(), got.beats_sec.len());
        cmp_usize("downbeats", expect.downbeats_sec.len(), got.downbeats_sec.len());
        // 老 analysis.json 的 meta 里没有 meter（只有 beatsPerBar）
        let em = expect.meter.clone().or(expect.meta.meter.clone()).unwrap_or(MeterInfo {
            numerator: expect.meta.beats_per_bar,
            denominator: 4,
            confidence: 0.0,
        });
        let gm = got.meter.clone().or(got.meta.meter.clone()).unwrap();
        cmp_usize("meter.num", em.numerator, gm.numerator);
        cmp_usize("meter.den", em.denominator, gm.denominator);
        cmp_usize("segments", expect.tempo_segments.len(), got.tempo_segments.len());
        cmp_usize(
            "chord(submission)",
            expect.chords.get("submission").map(|v| v.len()).unwrap_or(0),
            got.chords.get("submission").map(|v| v.len()).unwrap_or(0),
        );
        cmp_usize("sections", expect.sections.len(), got.sections.len());

        // 首个 downbeat / 首个拍点：偏一拍以上就说明网格相位错了
        cmp_f64(
            "downbeats[0]",
            expect.downbeats_sec.first().cloned().unwrap_or(0.0),
            got.downbeats_sec.first().cloned().unwrap_or(0.0),
        );
        cmp_f64(
            "beats[0]",
            expect.beats_sec.first().cloned().unwrap_or(0.0),
            got.beats_sec.first().cloned().unwrap_or(0.0),
        );

        // ---- 硬断言：提供 `MUSICANAZ_TEST_EXPECT` 时，关键指标必须对上 ----
        //
        // 只在显式给了期望文件时断言：仓库里默认的 analysis.json 是历史产物，
        // 拿它做硬断言会把「Python 改过算法」误报成「Rust 退化」。
        //
        // 容差说明：
        // - 拍点/小节线要求**逐项**在 30ms 内 —— 量化到帧级（512/22050=23.2ms）
        // - 和弦段数允差 ±3：调音偏差、CQT 边缘帧这些微差会合并/拆开个别段
        // - 结构段不做断言：Python 那边是已废弃的 all-in-one-infer，本来就不一致
        if std::env::var("MUSICANAZ_TEST_EXPECT").is_ok() {
            assert_eq!(
                expect.beats_sec.len(),
                got.beats_sec.len(),
                "拍数不一致"
            );
            assert_eq!(
                expect.downbeats_sec.len(),
                got.downbeats_sec.len(),
                "小节数不一致"
            );
            assert!((expect.meta.bpm_median - got.meta.bpm_median).abs() < 0.05, "BPM 不一致");
            assert_eq!(em.numerator, gm.numerator, "拍号分子不一致");
            assert_eq!(em.denominator, gm.denominator, "拍号分母不一致");
            assert_eq!(expect.tempo_segments.len(), got.tempo_segments.len(), "速度段数不一致");

            for (k, (a, b)) in expect
                .beats_sec
                .iter()
                .zip(got.beats_sec.iter())
                .enumerate()
            {
                assert!((a - b).abs() < 0.03, "beats[{k}] {a:.3} vs {b:.3}");
            }
            for (k, (a, b)) in expect
                .downbeats_sec
                .iter()
                .zip(got.downbeats_sec.iter())
                .enumerate()
            {
                assert!((a - b).abs() < 0.03, "downbeats[{k}] {a:.3} vs {b:.3}");
            }

            let ec = expect.chords.get("submission").map(|v| v.len()).unwrap_or(0);
            let gc = got.chords.get("submission").map(|v| v.len()).unwrap_or(0);
            assert!(
                (ec as i64 - gc as i64).abs() <= 3,
                "和弦段数差太多：python {ec} vs rust {gc}"
            );
        }

        // 和弦差异定位：找出第一处边界不一致
        if let (Some(ec), Some(gc)) = (expect.chords.get("submission"), got.chords.get("submission")) {
            let n = ec.len().min(gc.len()).min(12);
            println!("\n{:<6} {:<24} {:<24}", "i", "python (start-end chord)", "rust (start-end chord)");
            for i in 0..n {
                println!(
                    "{:<6} {:>8.3}-{:<8.3} {:<12} {:>8.3}-{:<8.3} {:<12}",
                    i, ec[i].start, ec[i].end, ec[i].chord, gc[i].start, gc[i].end, gc[i].chord
                );
            }
        }

        println!("\nrust sections: {:?}", got.sections);
        println!("python sections: {:?}", expect.sections);

        // 拍点/小节线序列的分叉点：长度不同时，看第一处时刻偏差
        find_divergence("beats", &expect.beats_sec, &got.beats_sec);
        find_divergence("downbeats", &expect.downbeats_sec, &got.downbeats_sec);
    }
    /// 性能 + 进度探针：跑一遍真实音频，打印每个进度点与各阶段耗时。
    ///
    /// ```text
    /// cargo test --lib perf_progress_probe -- --ignored --nocapture
    /// ```
    ///
    /// 用途：
    ///   1. 验证 **dev profile 的优化配置**有没有生效。`[profile.dev]` 一旦被
    ///      谁删掉（opt-level 回到 0），CQT/chroma 会从几秒变成几分钟，表现是
    ///      「正在分析」永久停在「计算 CQT 特征…」。这个探针会立刻暴露它。
    ///   2. 改分析链（换模型、改分块大小）后确认各阶段耗时没有退化成十几秒。
    ///
    /// 参考值（Ryzen 级别，4:50 的 flac）：全流程 ~23s，其中
    /// CQT 4s / 拍点推理 7s / 和弦 5 折 4s / chroma+SSM 3.5s。
    #[test]
    #[ignore]
    fn perf_progress_probe() {
        let path = std::path::PathBuf::from(r"E:\音乐\Aimer - Refrain.flac");
        if !path.exists() {
            eprintln!("跳过：找不到测试音频 {}", path.display());
            return;
        }
        let models = ModelPaths::discover().expect("模型目录");
        let t0 = std::time::Instant::now();
        let mut n = 0usize;
        let a = analyze_file(&path, &models, &mut |stage, pct, msg| {
            n += 1;
            println!(
                "[{:>6.1}s] {:>5.1}% {:?} {}",
                t0.elapsed().as_secs_f32(),
                pct * 100.0,
                stage,
                msg
            );
        })
        .expect("分析失败");
        println!(
            "总耗时 {:.1}s，进度点 {} 个，和弦 {} 段",
            t0.elapsed().as_secs_f32(),
            n,
            a.chords.get("submission").map(|v| v.len()).unwrap_or(0)
        );
    }

}
