# musicAnaz — 音乐和声研究工作台

把一首歌拆成**可编辑的和弦 / 结构 / 拍点 / 歌词**时间轴，用于和声研究、扒带和对齐分析。

> 核心目标：**零 Python 依赖的本地分析**。模型全部导出成 ONNX，推理在 Rust 里跑，
> 用户机器上不需要装 Python / PyTorch / conda。

---

## 目录

```
client/                 桌面应用（Tauri 2 + Vue 3 + Rust）
  src/                  前端：时间轴、曲库、检查器、播放条
  src-tauri/src/
    audio/              解码 / 重采样 / mel / CQT / chroma / 调音
    model/              beat_this、lv-chordia 5 折、XHMM、结构分析（ONNX）
    analysis/           拍点网格、量化、装配 analysis.json
    assets/             词表 + golden 基准（模型 .onnx 不入库，见下）
neural/                 Python 侧（对照引擎 + ONNX 导出脚本）
docs/                   开发文档与 ADR
testdata/               参考歌曲（音频 + 分析结果 + 编辑层）
scripts/                开发脚本
```

## 快速开始

```bash
cd client
bun install
bun run tauri dev
```

**完整环境搭建（含模型文件从哪来、上游仓库怎么拉）见 [`docs/dev-setup.md`](docs/dev-setup.md)。**
前端开发细节见 [`client/README.md`](client/README.md)。

## 两条分析链路

| 链路 | 说明 | 需要 Python |
|---|---|---|
| **Rust 原生（默认）** | `client/src-tauri/src/{audio,model,analysis}` + ONNX Runtime | ❌ |
| Python 对照 | `neural/analyze_song.py` + 4 个上游仓库 | ✅ |

两条链路的结果要求**逐值对齐**（`cargo test --lib` 里的 golden 测试，误差 1e-3 内），
Python 侧只用于排查差异和重新生成 ONNX。

## 模型与权重：为什么不入库

| 内容 | 位置 | 是否入库 | 原因 |
|---|---|---|---|
| 三档和弦词表、mel 滤波器组 | `client/src-tauri/assets/*.tsv,*.f32` | ✅ | 体积小，纯数据 |
| golden 测试基准 | `client/src-tauri/assets/golden_*` | ✅ | `include_bytes!` 编译期引用，缺了连 `cargo test` 都编译不过 |
| 导出后的 `.onnx` | 同上 | ❌ | 9.5 MB + 80 MB，可由 `neural/export_*.py` 重新生成 |
| 上游仓库与权重 | `neural/{lv-chordia,beat_this,...}` | ❌ | 第三方代码，体积 150 MB+，用锁定 commit 拉取 |

上游仓库拉取（锁定 commit，幂等）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-upstream.ps1
```

权重来源：`lv-chordia` 随仓库自带（83 MB）；`beat_this` / `all-in-one-infer` 首次运行时自动下载。
详见 [`docs/dev-setup.md`](docs/dev-setup.md) §3。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/dev-setup.md`](docs/dev-setup.md) | 环境搭建、上游仓库与权重、ONNX 导出、测试 |
| [`client/README.md`](client/README.md) | 前端结构、开发与测试命令 |
| [`PRD_音乐和声研究工作台_v2.0_自研时间轴.md`](PRD_音乐和声研究工作台_v2.0_自研时间轴.md) | 产品需求 |
| [`ROADMAP.md`](ROADMAP.md) | 里程碑 |
| [`docs/adr/`](docs/adr/) | 架构决策记录 |
| [`neural/patches/README.md`](neural/patches/README.md) | 上游改动约定（当前零改动） |

## 测试

```bash
cd client && bun run test          # 前端
cd client/src-tauri && cargo test --lib   # Rust（含与 Python 的逐值对齐）
```

⚠️ 两个容易踩的坑（详见 dev-setup）：
- `cargo test` 依赖 `assets/golden_*`，不能删也不能 gitignore
- `[profile.dev]` 的优化配置不能删，否则分析在 dev 下慢到跑不完
