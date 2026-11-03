//! 重采样：任意采样率 → 22050 Hz。
//!
//! ## 为什么用 rubato 而不是 soxr
//!
//! Python 侧用的是 `soxr`（libsoxr 的绑定，C 库）。Rust 的 `soxr` crate
//! 需要额外链接 libsoxr —— 多一个动态库就多一个分发风险（Windows 上要
//! 随包带 dll，mac 上要签名）。
//!
//! `rubato` 是**纯 Rust**，没有 C 依赖，质量也够：
//! 用 sinc 插值 + 抗混叠滤波，误差远低于 beat_this 对输入的敏感度
//! （它的输入是 log-mel，帧长 441 采样点，微小的重采样差异被 mel 平均掉）。
//!
//! ## 一致性验证
//!
//! `neural/golden/wave22k.npy` 是 Python 用 soxr 重采样的结果。
//! Rust 侧的结果要跟它逐点对比（见 `tests::matches_python_soxr`）。

use anyhow::Result;

/// 把单声道 f32 从 `src_rate` 重采样到 `dst_rate`。
///
/// 采样率相同时直接返回克隆，不走滤波器（少一次无谓的精度损失）。
pub fn resample_mono(input: &[f32], src_rate: u32, dst_rate: u32) -> Result<Vec<f32>> {
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };

    if src_rate == dst_rate || input.is_empty() {
        return Ok(input.to_vec());
    }

    let ratio = dst_rate as f64 / src_rate as f64;

    let params = SincInterpolationParameters {
        // 256 taps 是 rubato 文档推荐的「高质量」档
        sinc_len: 256,
        // rubato 0.15 这里是 f32（5.0 才改成 Option<f32>）
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let chunk = 8192usize;
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk, 1)?;

    let mut out: Vec<f32> = Vec::with_capacity((input.len() as f64 * ratio).ceil() as usize + 64);
    let mut pos = 0usize;

    while pos < input.len() {
        let end = (pos + chunk).min(input.len());
        let mut frame = input[pos..end].to_vec();
        // 最后一块不足 chunk：补零（rubato 要求定长输入）
        let pad = chunk - frame.len();
        if pad > 0 {
            frame.resize(chunk, 0.0);
        }
        let waves = vec![frame];
        match resampler.process(&waves, None) {
            Ok(mut res) => {
                let ch = res.pop().unwrap_or_default();
                // 补零产生的尾巴要丢掉，否则末尾会多出静音
                let keep = if end == input.len() {
                    ((input.len() - pos) as f64 * ratio).round() as usize
                } else {
                    ch.len()
                };
                out.extend_from_slice(&ch[..keep.min(ch.len())]);
            }
            Err(e) => return Err(anyhow::anyhow!("重采样失败: {e}")),
        }
        pos = end;
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_rate_is_passthrough() {
        let x = vec![0.1f32, -0.2, 0.3];
        let y = resample_mono(&x, 22050, 22050).unwrap();
        assert_eq!(x, y);
    }

    #[test]
    fn length_scales_with_ratio() {
        // 1 秒 48000 → 22050，长度应约为 22050
        let x = vec![0.0f32; 48000];
        let y = resample_mono(&x, 48000, 22050).unwrap();
        let err = (y.len() as i64 - 22050).abs();
        assert!(err < 200, "长度 {} 偏离 22050 太多", y.len());
    }
}
