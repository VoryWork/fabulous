//! 分析引擎调用。
//!
//! ## 当前状态：Python 子进程（开发期占位）
//!
//! 生产环境**不能依赖 Python**（用户明确否决分发 Python 运行时）。
//! 所以这里定义一个 `Analyzer` trait，两种实现：
//!
//! | 实现 | 用途 | 可用性 |
//! |---|---|---|
//! | `PythonAnalyzer` | 开发期，调 `neural/analyze_song.py` | 仅开发机 |
//! | `OnnxAnalyzer`（M7 待实现） | 生产，`ort` crate + ONNX 模型 | 可分发 |
//!
//! 上层（`commands.rs`）只依赖 trait，换引擎时不用改业务代码。
//!
//! ## 为什么用子进程而不是 FFI
//!
//! - PyTorch 模型加载要 5–30s，且会占几百 MB 到几 GB 内存。
//!   子进程可以**用完就退**，也可以**常驻复用**（见 `spawn` 策略）。
//! - Python 崩溃不会带崩 Tauri 主进程。
//! - 开发和调试时可以单独跑脚本，不用重新编译整个应用。

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 分析进度事件
#[derive(Debug, Clone, Serialize)]
pub struct AnalysisProgress {
    /// 当前阶段：probe / beats / chords / structure / done
    pub stage: String,
    /// 0.0–1.0
    pub pct: f64,
    /// 给用户看的一句话
    pub message: String,
    /**
     * 阶段性结果（可选）。
     *
     * 分析是分阶段的（拍点 → 和弦 → 结构），每个阶段结束都能给出一份
     * "目前拿到的全部内容"。带上它前端就能**边分析边渲染**，
     * 而不是盯着空白窗口等好几分钟。
     *
     * `None` = 纯进度事件，没有数据可画。
     */
    pub partial_json: Option<String>,
}

/// 分析结果（模型原始输出）
#[derive(Debug, Clone, Serialize)]
pub struct AnalysisOutput {
    /// 完整的 analysis.json 内容（前端直接用）
    pub json: String,
}

/// 分析引擎接口
pub trait Analyzer: Send + Sync {
    /// 分析一首歌。
    ///
    /// `on_progress` 会在分析过程中多次调用（用于推送到前端）。
    fn analyze(
        &self,
        audio_path: &Path,
        on_progress: &mut dyn FnMut(AnalysisProgress),
    ) -> Result<AnalysisOutput>;
}

/** 取字符串尾部最多 n 个字符（按字符边界安全截断） */
fn tail_of(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let start = s.len() - n;
    // 找最近的字符边界，避免切坏 UTF-8
    let safe = (start..s.len())
        .find(|&i| s.is_char_boundary(i))
        .unwrap_or(s.len());
    format!("…（省略前 {} 字节）
{}", safe, &s[safe..])
}

/// Python 分析引擎（开发期）
pub struct PythonAnalyzer {
    /// `analyze_song.py` 的路径
    script: PathBuf,
    /// Python 解释器（conda 环境里的）
    python: String,
}

impl PythonAnalyzer {
    pub fn new(script: PathBuf, python: impl Into<String>) -> Self {
        Self {
            script,
            python: python.into(),
        }
    }

    /// 自动探测：从仓库结构推断脚本位置与 Python
    ///
    /// 开发期布局：`<repo>/client/src-tauri` + `<repo>/neural/analyze_song.py`
    pub fn detect() -> Option<Self> {
        // 从当前可执行文件往上找 repo 根
        let mut dir = std::env::current_exe().ok()?;
        for _ in 0..6 {
            dir = dir.parent()?.to_path_buf();
            let script = dir.join("neural").join("analyze_song.py");
            if script.is_file() {
                // 优先用 conda 环境里的 python
                let candidates = [
                    r"C:\miniconda3\envs\harmonize\python.exe",
                    "python",
                    "python3",
                ];
                for py in candidates {
                    if let Ok(out) = Command::new(py).arg("--version").output() {
                        if out.status.success() {
                            return Some(Self::new(script, py));
                        }
                    }
                }
                return Some(Self::new(script, "python"));
            }
        }
        None
    }
}

impl Analyzer for PythonAnalyzer {
    fn analyze(
        &self,
        audio_path: &Path,
        on_progress: &mut dyn FnMut(AnalysisProgress),
    ) -> Result<AnalysisOutput> {
        if !self.script.is_file() {
            return Err(anyhow!(
                "找不到分析脚本 {}（生产环境应改用 ONNX 引擎）",
                self.script.display()
            ));
        }

        on_progress(AnalysisProgress {
            stage: "probe".into(),
            pct: 0.0,
            message: "启动分析引擎…".into(),
            partial_json: None,
        });

        let mut child = Command::new(&self.python)
            .arg("-u") // 关掉输出缓冲，否则读不到实时进度
            .arg(&self.script)
            .arg(audio_path)
            // 强制 Python 用 UTF-8 输出。
            // Windows 上 Python 默认按 ANSI 代码页（中文系统 GBK/cp936）写 stdout，
            // 而 Rust 侧按 UTF-8 解析 -> 遇到中文字节就解码失败。
            // 实测：不设这两个变量时，读 stdout 在第一条含中文的进度行就出错，
            // 循环提前 break，结果永远拿不到。
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("无法启动 {}", self.python))?;

        let stdout = child.stdout.take().ok_or_else(|| anyhow!("无法读取分析输出"))?;
        let stderr = child.stderr.take();

        /**
         * **必须读 stderr**，否则：
         *   1. Python 的 traceback 全丢（用户只看到"退出码 1"，无从排查）
         *   2. stderr 管道缓冲区写满后子进程会**阻塞**（死锁）
         *
         * 这里起一个线程收集，失败时把尾部内容附到错误信息里。
         */
        let err_thread = stderr.map(|se| {
            std::thread::spawn(move || {
                use std::io::Read;
                // 用字节读 + lossy 解码：模型库的日志可能含任意字节，
                // read_to_string 遇到非 UTF-8 会整体失败，导致 stderr 全丢。
                let mut bytes = Vec::new();
                let mut r = BufReader::new(se);
                let _ = r.read_to_end(&mut bytes);
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });

        let mut reader = BufReader::new(stdout);

        // 协议：脚本往 stdout 打 JSONL
        //   {"type":"progress","stage":"beats","pct":0.3,"message":"..."}
        //   {"type":"result","json":"..."}
        //   {"type":"error","message":"..."}
        let mut result: Option<String> = None;
        let mut script_error: Option<String> = None;

        /**
         * 逐行读：用 `read_until(b'
')` + `from_utf8_lossy`，不用 `lines()`。
         *
         * 原因：`lines()` 遇到非 UTF-8 字节会返回 `Err`，而旧代码 `Err(_) => break`
         * 会**静默截断整个分析结果**。模型库（madmom/demucs）偶尔往 stdout 打二进制
         * 或乱码，一条就够让整个流程失败。
         *
         * lossy 解码会把坏字节替换成 U+FFFD，协议行（纯 ASCII/UTF-8）不受影响。
         */
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            let n = match reader.read_until(0x0A, &mut buf) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[analyzer] 读分析输出失败: {e}");
                    0
                }
            };
            if n == 0 {
                break; // EOF
            }
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue, // 非协议行（模型库的日志），忽略
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("progress") => {
                    on_progress(AnalysisProgress {
                        stage: v
                            .get("stage")
                            .and_then(|s| s.as_str())
                            .unwrap_or("working")
                            .to_string(),
                        pct: v.get("pct").and_then(|p| p.as_f64()).unwrap_or(0.0),
                        message: v
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string(),
                        partial_json: None,
                    });
                }
                Some("partial") => {
                    // 阶段性结果：带上目前已经拿到的内容，前端可以先画出来
                    let stage = v
                        .get("stage")
                        .and_then(|s| s.as_str())
                        .unwrap_or("partial")
                        .to_string();
                    if let Some(json) = v.get("json").and_then(|j| j.as_str()) {
                        on_progress(AnalysisProgress {
                            stage: format!("partial:{stage}"),
                            pct: -1.0, // 负值 = 不是进度更新，只是数据推送
                            message: String::new(),
                            partial_json: Some(json.to_string()),
                        });
                    }
                }
                Some("result") => {
                    result = v.get("json").and_then(|j| j.as_str()).map(String::from);
                }
                Some("error") => {
                    script_error = v.get("message").and_then(|m| m.as_str()).map(String::from);
                }
                _ => {}
            }
        }

        let status = child.wait()?;

        // 收集 stderr（子进程结束后线程才结束）
        let stderr_text = err_thread
            .and_then(|h| h.join().ok())
            .unwrap_or_default();

        if let Some(e) = script_error {
            return Err(anyhow!("分析失败: {e}"));
        }
        if !status.success() {
            // 取 stderr 尾部（traceback 最关键的部分在最后）
            let tail = tail_of(&stderr_text, 3000);
            return Err(anyhow!(
                "分析进程退出码 {:?}{}",
                status.code(),
                if tail.is_empty() {
                    String::new()
                } else {
                    format!("

--- Python stderr ---
{tail}")
                }
            ));
        }

        let json = result.ok_or_else(|| anyhow!("分析没有返回结果"))?;

        on_progress(AnalysisProgress {
            stage: "done".into(),
            pct: 1.0,
            message: "分析完成".into(),
            partial_json: None,
        });

        Ok(AnalysisOutput { json })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 Tauri 相同的方式调 Python，看真实错误
    ///
    /// 本地：cargo test --lib -- --ignored --nocapture
    #[test]
    #[ignore]
    fn python_analyzer_real() {
        let audio = Path::new(r"E:\音乐\藤井風 - 満ちてゆく.flac");
        if !audio.is_file() {
            eprintln!("跳过：测试文件不存在");
            return;
        }

        let a = PythonAnalyzer::detect().expect("未探测到分析脚本");
        println!("脚本: {:?}", a.script);
        println!("python: {}", a.python);
        println!("cwd: {:?}", std::env::current_dir());

        let mut stages = Vec::new();
        match a.analyze(audio, &mut |p| {
            stages.push(p.stage.clone());
        }) {
            Ok(out) => {
                println!("✓ 分析成功，{} 字节", out.json.len());
                println!("阶段: {:?}", stages);
            }
            Err(e) => {
                panic!("✗ 分析失败:\n{e}");
            }
        }
    }
}
