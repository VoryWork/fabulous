# Fabulous — 音乐和声研究工作台

把一首歌自动拆成**和弦 / 结构 / 拍点 / 歌词**四条可编辑的时间轴，用于扒带、和声分析和对齐研究。

分析全在本地跑（ONNX + Rust），**不需要 Python、不需要联网、音频不上传**。

---

## 这是什么

自动和弦识别工具的通病是「给个结果，改不了」。实际扒带时你需要的是：

- 模型认错了一个和弦 → **直接改正**
- 想按级数（Ⅰ Ⅴ Ⅵ Ⅳ）理解，而不是只看 C G Am F → **切级数轨**
- 副歌边界差半小节 → **拖一下**
- 想跟着原曲听自己标的和声 → **时间轴和音频同步**

所以这个工具的定位是**编辑器**：模型负责把 90% 铺好，剩下的手工修。
所有手工修改单独存在 `edits.json` 里，重新分析不会丢。

## 功能

| | |
|---|---|
| **曲库** | 搜索、排序、虚拟滚动；按音频指纹识别同一首歌，换机器/移动文件后可重新定位 |
| **自动分析** | 拍点与小节网格、和弦（三档词表可切换）、段落结构、调性 + 音分偏差校正 |
| **时间轴编辑** | 和弦块拖动 / 切分 / 合并 / 改文本、结构段增删改、拍点吸附、撤销重做 |
| **级数轨** | 数字级数（`1 5 6 4`），跟随调性自动换算；保留和弦性质与转位（`5:7/3`），父和弦一改就跟着更新 |
| **歌词轨** | 导入 LRC（标准格式或网易云 JSON），吸附到拍点，逐行可编辑 |
| **播放** | 波形（真实峰值）、循环区间、点击定位、时间轴与播放头同步 |
| **工程文件** | 导出 `.fbsong`（纯文本 JSON，分析结果 + 编辑层，一个字段不裁），可换机继续编辑 |

支持音频格式（symphonia 解码）：**flac / mp3 / m4a(aac) / ogg(vorbis) / wav**。

## 快速开始

### 直接用

发布包解压即可运行，不需要装任何东西：

```
Fabulous/
  Fabulous.exe           前端已嵌入
  onnxruntime.dll        推理运行时
  beat_this_final.onnx   拍点模型（80 MB）
  chord_fold0..4.onnx    和弦模型 5 折（9.5 MB）
  chord_vocab_*.tsv      和弦词表
```

点「+」选音频 → 等分析（4 分钟的歌约 20 秒）→ 开始编辑。
分析结果和编辑都存在本地数据库，下次打开直接续上。

### 从源码

```bash
cd client
bun install
bun run tauri dev
```

需要 Rust 1.85+、bun、MSVC 工具链。**首次运行前要先准备模型文件**——
完整步骤见 [`docs/dev-setup.md`](docs/dev-setup.md)（含模型从哪来、上游仓库怎么拉）。

## 数据在哪

```
%APPDATA%\com.xmmpp.client\
  fabulous.db              曲库索引（路径、标题、指纹）
  songs\<id>\
    analysis.json          模型产物：拍点 / 和弦 / 结构 / 调性
    edits.json             用户编辑层：调性覆盖 / 级数轨 / 和弦编辑 / 结构编辑 / 歌词
```

**两个文件分开是有意的**：

- `analysis.json` 是模型的输出，**重新分析会整个覆盖**
- `edits.json` 是你做的事，永远不会被模型结果冲掉

所以看到「重新分析后我的修改没了」这种情况应该不会发生——如果遇到了，是 bug。

### `.fbsong` 工程文件

导出时把 `analysis.json` + `edits.json` 打成一个纯文本 JSON：

```json
{
  "format": "fbsong",
  "version": 1,
  "exportedAt": "2026-11-03T...",
  "analysis": { ... },   // 一字段不裁
  "edits": { ... },
  "view": { ... }        // 导出时的界面状态，纯参考
}
```

- **不含音频**（版权 + 体积）。导入后走「音频失效 → 重新定位」，按指纹匹配本地文件
- 纯文本是为了能用记事本打开排查、能被脚本处理、git diff 能读
- 换机器、分享给同好、归档都靠它

## 架构

```
┌─ Vue 3 前端 ────────────────────────────────┐
│  时间轴（canvas）/ 曲库 / 检查器 / 播放条     │
└────────────────┬───────────────────────────┘
                 │ Tauri IPC
┌────────────────▼───────────────────────────┐
│ Rust（client/src-tauri）                     │
│  audio/     解码 · 重采样 · mel · CQT · chroma · 调音
│  model/     beat_this · lv-chordia 5 折 · XHMM · 结构
│  analysis/  拍点网格 · 量化 · 装配 analysis.json
│  db.rs      SQLite（rusqlite bundled，免装）
└────────────────────────────────────────────┘
```

两条分析链路，结果要求**逐值对齐**（golden 测试误差 1e-3 内）：

| 链路 | 用途 | 需要 Python |
|---|---|---|
| **Rust 原生（默认）** | 实际运行，发布版只有这条 | ❌ |
| Python 对照 | 查「Rust 和 Python 为什么不一样」、重新导出 ONNX | ✅ |

## 模型与权重：为什么不入库

| 内容 | 是否入库 | 原因 |
|---|---|---|
| 和弦词表、mel 滤波器组、golden 基准 | ✅ | 体积小；golden 是 `include_bytes!` 编译期引用，缺了连测试都编译不过 |
| 导出后的 `.onnx` | ❌ | 9.5 + 80 MB，可由 `neural/export_*.py` 重新生成，发布包里已带 |
| 上游仓库与权重 | ❌ | 第三方代码 150 MB+，用锁定 commit 拉取（权重首次运行自动下载） |

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-upstream.ps1   # 幂等，锁定 commit
```

## 测试

```bash
cd client && bun run test                  # 前端 332 例
cd client/src-tauri && cargo test --lib    # Rust 92 例（含与 Python 的逐值对齐）
```

三个坑（详见 dev-setup）：

- `cargo test` 依赖 `assets/golden_*`，**不能删也不能 gitignore**
- `[profile.dev]` 的优化配置不能删，否则分析在 dev 下慢 20~50 倍
- `testdata/songs/*/audio.flac` **不在仓库里**（版权），少数 `#[ignore]` 测试会在缺音频时跳过；
  想复现具体数值请自备原版录音，见 [`testdata/README.md`](testdata/README.md)

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/dev-setup.md`](docs/dev-setup.md) | 环境搭建、模型与上游仓库、ONNX 导出、打包发布 |
| [`client/README.md`](client/README.md) | 前端结构、开发与测试命令 |
| [`docs/PRD_音乐和声研究工作台_v2.0_自研时间轴.md`](docs/PRD_音乐和声研究工作台_v2.0_自研时间轴.md) | 产品需求 |
| [`ROADMAP.md`](ROADMAP.md) | 里程碑 |
| [`docs/adr/`](docs/adr/) | 架构决策记录 |
| [`neural/patches/README.md`](neural/patches/README.md) | 上游改动约定（当前零改动） |

## 许可与版权

**本项目代码：[MIT](LICENSE)。**

发布包里分发的模型权重都来自 MIT 许可的开源项目，版权归各自作者：
完整版权行、许可全文、以及全部 Rust / npm 依赖的许可清单见
**[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**（由 `scripts/gen-third-party.py` 生成）。

| 组件 | 用途 | 许可 | 是否随包分发 |
|---|---|---|---|
| [beat_this](https://github.com/CPJKU/beat_this) | 拍点 / 小节 | MIT | ✅ `beat_this_final.onnx` |
| [lv-chordia](https://github.com/openmirlab/lv-chordia) | 和弦识别 | MIT | ✅ `chord_fold0..4.onnx` |
| [all-in-one-infer](https://github.com/openmirlab/all-in-one-infer) | 段落结构（仅 Python 对照链路） | MIT | ❌ 权重首次运行自取 |
| [demucs-infer](https://github.com/openmirlab/demucs-infer) | 源分离（可选） | MIT | ❌ 权重首次运行自取 |

### MStruct 格式与官方编辑器

`.mstruct` 导出格式（`client/src/export/mstruct.ts`）对齐
[MStruct Editor](https://github.com/Polymath9/mstruct-editor) 的官方实现。
上游是**分层许可**，这里逐条说明我们用到的是哪一层：

| 上游内容 | 我们怎么用 | 许可 | 义务 |
|---|---|---|---|
| 软件源码，含 `src/core/mstruct-document.js` 的 `serializeMstructDocument()` | 照抄实现（文件骨架、`{TAG}value` 元数据行格式、槽位时值合并规则） | [MIT](https://github.com/Polymath9/mstruct-editor/blob/master/LICENSE) | 保留版权与许可声明 |
| 语法文档、技术手册、`examples/*.mstruct` 原创分析 | 参考语法规则与示例 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 署名「MStruct Editor contributors」，注明来源文件/版本，说明有修改 |
| MStruct / MStruct Archive **名称、Logo、官方兼容标识** | **未使用** | ❌ 不在任何开源授权内 | 保留品牌权利 |

版权行：

- 软件源码：`Copyright (c) 2026 MStruct Editor contributors`
- 文档与分析：`Copyright © 2026 MStruct Editor contributors`（CC BY 4.0）

> ⚠️ **名称与标识不在授权范围内。** 上游 `LICENSE-SCOPE.md` 明确：MIT 不覆盖
> 「MStruct、MStruct Archive 的名称、Logo 与官方兼容标识」，
> 且「随官方软件分发不代表授予独立品牌使用权」。
> 所以我们只能说「**导出格式兼容 MStruct**」，不宣称自己是 MStruct 官方产品、
> 不使用其 Logo，也不暗示得到官方背书。`MStruct` 仅作为格式名称（factual 引用）出现。

> 上游技术手册另以 DOI [10.5281/zenodo.23637500](https://doi.org/10.5281/zenodo.23637500) 发布，
> 引用该 DOI 不构成对其中内容的再分发。

Rust 依赖里有 17 个 crate 是 **MPL-2.0**（`cssparser` 等，来自 Tauri 的 CSS 解析）。
它们是用 crates.io 原版、未做修改，MPL 只覆盖这些文件本身，不影响本项目的 MIT 许可；
分发二进制时按 MPL §3.2 指明源码位置即可（crate 名与版本见 NOTICE 文件）。

### ⚠️ 关于训练数据

`beat_this` 上游 README 有一句需要原样转达的提示：

> 代码与发布的模型权重是 MIT，但**部分训练素材是完全版权作品或受限的 Creative Commons 授权**，
> 使用者需自行评估这是否会影响自己的使用场景。

我们不做二次判断，把这句话放在这里由使用者自行评估。

### 音频

本仓库与发布包**都不包含任何音频文件**。`testdata/` 里只有我们自己跑出来的分析结果
（`analysis.json` 等），不含原始录音。参考音频属于各自的版权方，需要使用者自备。
