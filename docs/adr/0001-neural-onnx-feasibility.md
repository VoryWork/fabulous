# ADR-0001：神经网络模型的 ONNX 导出可行性（M0-V2/V3 实测结论）

> 状态：**已决定**
> 日期：2026-11-01
> 环境：Windows + RTX 5070 Ti (sm_120) + Python 3.11.18 + torch 2.11.0+cu128 + onnxruntime-gpu 1.31.1
> 关联：`ROADMAP.md` M0（V2/V3）、M7

---

## 1. 背景

产品需要一个**用户侧零 Python**的桌面端。因此神经网络模型必须以 ONNX 形式在 Rust 里通过 `ort` 加载，或至少证明该路线不可行。

本 ADR 记录对两个候选模型的实测结果。

---

## 2. 环境实测（先决条件）

| 项 | 结果 |
|---|---|
| GPU | NVIDIA GeForce RTX 5070 Ti |
| 算力 | `capability (12, 0)` = **sm_120 (Blackwell)** |
| torch | 2.11.0+cu128，`cuda.is_available() = True` |
| torch 预编译 arch | `['sm_75','sm_80','sm_86','sm_90','sm_100','sm_120']` ✅ 含 sm_120 |
| onnxruntime 可用 EP | `TensorRT / CUDA / CPU` |
| conda 环境 | `harmonize`（Python 3.11.18） |

> **结论：RTX 50 系列必须用 cu128 及以上的 torch。** 旧版 torch（cu118/cu121）会报 "no kernel image is available"，这一点在选型时最容易踩坑。

---

## 3. beat_this（拍点识别）

### 3.1 模型事实

| 项 | 值 |
|---|---|
| 参数量 | 20,251,712（**81 MB** fp32） |
| 输入 | `spect: (B, T, 128) float32`（log-mel，归一化格式见下） |
| 输出 | `beat_logits: (B, T)`、`downbeat_logits: (B, T)`（**逐帧 logits，未 softmax**） |
| 输出类型 | Python 侧是 `dict`，不是 tuple |
| 动态 T | ✅ 实测 T ∈ {200, 300, 1500, 3000} 全部正常 |

**前处理参数（`LogMelSpect`）**

```
sample_rate = 22050, n_fft = 1024, hop_length = 441  (→ 50 FPS)
f_min = 30, f_max = 11000, n_mels = 128
mel_scale = "slaney", norm = "frame_length", power = 1（幅度谱）
输出 = log1p(1000 * mel)   并转置成 (T, 128)
采样率不是 22050 时先 soxr 重采样
```

**后处理**：`split_predict_aggregate(chunk_size=1500, overlap_mode="keep_first", border_size=6)` + `Postprocessor(type="minimal" | "dbn", fps=50)`。这些是纯 Python 控制流（含 `while` 循环、peak picking、DBN/Viterbi），**必须 Rust 重写**。

### 3.2 ONNX 导出结论：**可行，但有一个致命细节**

导出使用 opset 17、`dynamo=False`（经典 TorchScript exporter）、`dynamic_axes` 标注 batch 与 frames。

#### 🔴 致命细节：`rotary_embedding_torch` 的频率缓存被 trace 固定

**现象（实测）**

| 导出时的示例长度 | 测试 T | CPU EP 与 torch 差异 | CUDA EP 与 torch 差异 |
|---|---|---|---|
| **300**（= 测试长度） | 300 | **1.610** ❌ | **1.609** ❌ |
| **300** | 600 | **2.223** ❌ | **2.223** ❌ |
| **300** | 1500 | **1.790** ❌ | **1.789** ❌ |
| **1600**（> 测试长度） | 300 | **3.07e-06** ✅ | 1.50e-03 |
| **1600** | 1500 | **3.07e-06** ✅ | 1.83e-03 |

> ⚠️ 注意第一行的反直觉结果：**连和导出长度相同的 T=300 都对不上**（差异 1.6）。
> 原因是 `export_beat_this.py` 里的导出和校验各自 `BeatThis()` **随机初始化**了不同权重——
> 这个实验设计有缺陷；但**不影响**核心结论，因为实验 2 用的是**同一个 wrapper 实例**
> （`w2`），导出与校验共用同一份权重，所以实验 2 的数据是可信的。

**根因**

`rotary_embedding_torch` 的 `RotaryEmbedding` 在 trace 期间执行了：

```python
if (offset + seq_len) <= self.cached_freqs_seq_len:   # ← TracerWarning 明确报了
    ... 使用缓存 ...
```

`self.cached_freqs_seq_len` 是一个**Python 属性**，不是张量。trace 时这个分支被**固化成常量**：

- 若导出长度 < 运行长度 → 运行时**不会重新计算频率缓存**，RoPE 位置编码错位 → 输出完全错误（量级 1e0）
- 若导出长度 ≥ 运行长度 → 缓存足够，结果正确

**对策（必须写进 M7 实施规范）**

> **导出 beat_this 时，示例输入的长度必须 ≥ 推理时会用到的最大长度。**

由于上游 `split_predict_aggregate` 已经把音频切成 `chunk_size=1500` 帧的块（1500 / 50fps = 30 秒），所以**导出时用 1600 帧即可覆盖全部运行场景**，且 `border_size=6` 的边界也已包含。

这是一个**「能在不合适的长度下静默产生垃圾结果」** 的坑——不会报错，只会让你的拍点全乱。必须写进测试。

### 3.3 数值精度（导出长度 1600，同一权重）

| EP | max\|diff\| vs torch |
|---|---|
| CPU EP | **3.07e-06** ✅ 优秀 |
| CUDA EP | 1.83e-03 ✅ 可接受（fp32 累积顺序差异，非逻辑错误） |

> CUDA EP 的 1e-3 量级误差来自 GEMM/Attention 的 fp32 归约顺序，属正常现象。
> 对"拍点是否落在同一帧"这个下游用途，1e-3 的 logits 差异不会改变 argmax/峰值位置。

### 3.4 性能（T=1500，即 30 秒音频）

| 实现 | 中位耗时 |
|---|---|
| ORT CPU EP | **570.3 ms** |
| ORT CUDA EP | **27.9 ms** |
| torch.cuda | 18.2 ms |

> **加速比 ≈ 20x。** 这与"小模型 GPU 收益有限"的预判**不符**——Transformer 类模型在 GPU 上收益显著。
> 一首 4 分钟歌曲 = 8 个 30 秒块 ≈ 220ms (CUDA) / 4.5s (CPU)。

---

## 4. lv-chordia（和弦识别）

### 4.1 模型事实

| 项 | 值 |
|---|---|
| `SPEC_DIM` | 252 |
| `SHIFT_HIGH=6`, `SHIFT_STEP=3` | 输入取 `x[:, 18:270]`（先 CQT 出 288 维，切中间 252 维） |
| `CNNFeatureExtractor.output_size` | 240 |
| ChordNetCNN（纯 CNN） | 211,300 参数 |
| ChordNet（CNN + BiLSTM） | 500,772 参数 |
| 权重 | 5.7 MB × 5 (s0..s4 五个 seed) |
| 输出 | 6 个概率头（softmax 后）：triad / bass / 7th / 9th / 11th / 13th |

**六个头的维度**：`triad_limit=6`、`bass=12+1`、`seventh=3+1`、`ninth=3+1`、`eleventh=2+1`、`thirteenth=2+1`；`bass_slice_begin=73`。

**前处理（`CQTV2`）**

```
librosa.hybrid_cqt(y, sr=?, bins_per_octave=36, n_bins=288,
                   fmin=librosa.note_to_hz('F#0'), hop_length=512)
→ abs() → float32
```

### 4.2 ONNX 导出评估

| 风险点 | 评估 |
|---|---|
| `InstanceNorm2d` / `Conv2d` / `MaxPool2d` / `SELU` | ✅ ONNX 原生支持 |
| `transpose + view` | ✅ 展开为 Transpose / Reshape |
| Bidirectional LSTM（仅 `ChordNet`） | ⚠️ ONNX 支持，但动态 T 下 shape 推理易出错 |
| `ChordNetCNN`（纯 CNN，无 LSTM） | ✅ **风险最低，且每帧独立**（无状态、可任意分块） |
| 输入切片 `x[:, 18:270]` 在 `inference()` 里 | ⚠️ 导出需包 wrapper，把切片放进图内或在前处理阶段切好 |
| **`librosa.hybrid_cqt`** | 🔴 **不在图内，必须 Rust 重写，且 CQT 比 mel 复杂得多** |

> **策略**：优先导出 **`ChordNetCNN`**（无 LSTM、每帧独立、可流式分块），避开 LSTM 的动态 T 问题。
> 若必须用 LSTM 版，则固定 T + 滑窗 + 50% overlap。

---

## 5. all-in-one-infer（段落/节拍）

### 5.1 事实

- 依赖 **`demucs-infer`（源分离）+ `madmom-infer`**，二者通过 `git+https` 直接引用 GitHub 固定 commit
- 依赖 `hydra-core` / `omegaconf`（配置系统）
- 自己实现了 `neighborhood_attention.py`（纯 PyTorch，无编译扩展）
- 同时输出 **beat / downbeat / tempo / segments**，需要**先做源分离**

### 5.2 评估

| 项 | 结论 |
|---|---|
| ONNX 化难度 | 🔴 **最高** |
| 原因 1 | `demucs-infer` 是另一个大模型（源分离），也要一起 ONNX 化，否则做不到零 Python |
| 原因 2 | 依赖链混入 madmom（大量 C 扩展 + 动态规划后处理） |
| 原因 3 | Git 依赖版本不稳定，且需网络安装 |
| 与 beat_this 重合 | 拍点功能完全重复 |
| 增量价值 | 主要来自**段落结构**（主歌/副歌/桥段） |

> **建议：Phase 1 不接入 all-in-one-infer。**
> 段落识别先用**纯信号处理**方案（自相似矩阵 + 重复段检测 + 能量分段）实现，
> 见 `ROADMAP.md` M4 的 A 档。等 M5 之后若段落质量确实不够，再单独评估"只取段落模型"的可行性。

---

## 6. 决定

### 6.1 V3（beat_this）：✅ **通过**

- 可导出 ONNX，CPU EP 精度 3e-06，CUDA EP 1.8e-03
- 性能：CPU 570ms → CUDA 28ms（**20x**）
- **强制约束**：导出时必须用 **T=1600** 的示例输入（覆盖 chunk_size=1500 的所有运行场景）

### 6.2 V2（lv-chordia）：⚠️ **有条件通过**

- 用 **`ChordNetCNN`**（纯 CNN）而非 `ChordNet`（含 LSTM）
- 前处理 CQT 需要 Rust 重写，**工作量显著大于 mel**
- **需单独排期验证**（本 ADR 未实测导出，只做了结构评估）

### 6.3 all-in-one-infer：❌ **本阶段不接入**

- 段落识别先用纯信号处理方案

### 6.4 对 M7 的影响

| 模型 | M7 状态 | 备注 |
|---|---|---|
| beat_this | ✅ 纳入 M7 | 优先级最高，收益已量化 |
| lv-chordia | ⚠️ 纳入 M7（用 CNN 版） | 需先补齐 CQT 的 Rust 实现 |
| all-in-one-infer | ❌ 移出 | 用 A 档信号处理替代 |

---

## 7. 后续必须做的事

1. ✅ ~~导出 beat_this 并测数值~~（本 ADR 已完成）
2. ⬜ 实测 **lv-chordia / ChordNetCNN 的 ONNX 导出**，补齐 V2 的量化数据
3. ⬜ 生成**黄金测试数据**：用 librosa 导出 `hybrid_cqt` 中间张量、用 torchaudio 导出 `MelSpectrogram` 中间张量，作为 Rust 前处理实现的逐元素断言基准
4. ⬜ 修正本次实验的方法缺陷：导出与校验必须**共用同一个模型实例**（本次实验 1 的 1.6 差异是权重不同导致，非真实问题）
5. ⬜ 在 Rust `ort` 侧验证 DirectML EP 是否同样支持 beat_this 的算子集（本次只测了 CUDA/CPU EP）

---

## 8. 新增的工程约束（写入 M7 实施规范）

> **面向 RoPE / 位置编码这类带 Python 侧缓存的 transformer 模型，ONNX 导出时的示例长度必须 ≥ 运行时的最大序列长度，否则会静默产出错误结果。**

这条必须变成自动化测试：

```python
# 导出长度必须覆盖推理最大窗口
assert export_len >= max_inference_len
# 并且在两个极端长度上都做数值校验，而不只是中间值
for T in (1, max_inference_len):
    assert max|diff| < 1e-2
```

---

## 附：可复现脚本

| 文件 | 用途 |
|---|---|
| `neural/probe_models.py` | 打印模型结构、输入输出形状、前处理参数 |
| `neural/export_beat_this.py` | beat_this 的 ONNX 导出 + 数值校验 + EP 耗时对比 |
| `neural/diagnose_beat_this.py` | 定位 RoPE 缓存导致的长序列误差问题 |

复现方式：

```bash
conda activate harmonize
cd f:/Repo/musicAnaz
python neural/probe_models.py
python neural/export_beat_this.py
python neural/diagnose_beat_this.py
```

---

# 附录 A：真实音频端到端验证（2026-11-01 追加）

> 测试曲目：`E:\音乐\Aimer - 六等星の夜.flac`（FLAC 44.1kHz 立体声，header 声明 337.92s）
> 脚本：`neural/final_beat_this.py`、`neural/plot_beats.py`

## A.1 最重要的发现：8192 是 RoPE 的硬编码上限

### 现象

用真实全曲（16751 帧）直接跑 ONNX 时报：

```
onnxruntime ... InvalidArgument : Non-zero status code returned while running Expand node.
Name: '/model/frontend/blocks/blocks.0/partial/attnT/Expand_1'
Status Message: invalid expand shape
```

### 根因（已定位到源码行）

```python
# rotary_embedding_torch/rotary_embedding_torch.py:105
cache_max_seq_len = 8192
self.register_buffer('cached_freqs', torch.zeros(cache_max_seq_len, dim), persistent=False)

# :247 / :327
should_cache = (... and (offset + seq_len) <= self.cache_max_seq_len)
```

- `seq_len <= 8192`：走缓存分支 `self.cached_freqs[:seq_len]`，trace 成 ONNX `Slice`，
  buffer 长度固定 8192，**任意长度都能正常跑**
- `seq_len > 8192`：走重新计算分支，trace 时 T 被固化成导出长度 → 产生固定 `Expand` shape
  → 运行时 T 更大即失败

### 实测边界（二分法确认）

| 导出长度 | 可用最大 T | 说明 |
|---|---|---|
| 1600 | **8192 OK / 8193 FAIL** | |
| 8000 | **8192 OK / 12000 FAIL** | 与导出长度无关 |

> **结论：8192 是固定硬上限，不是导出长度决定的。**
> 这点纠正了本 ADR 正文 §3.2 的初版结论（当时误以为只需"导出长度 ≥ 运行长度"）。

### 两种修复方案

| 方案 | 做法 | 结果 |
|---|---|---|
| **A** | 导出前把 `cache_max_seq_len` 调到 20000 | T=8193 起可通过，但 **T≥12000 时 `bad allocation`**（注意力 O(T²)，内存爆炸） |
| **B** ✅ | **保持默认，按 chunk 分块推理** | 与上游 `split_predict_aggregate` 默认行为一致，稳定可靠 |

**采用方案 B**。分块不是可选优化，而是**必须**。

> 实现方案 A 时的坑：`cached_freqs` 形状是 `(cache_max_seq_len, dim)`，
> `dim` 是 **head_dim（32）**，不是 `freqs.shape[-1]`（16）。写错会报
> `The expanded size of the tensor (16) must match the existing size (32)`。

---

## A.2 分块聚合必须精确复刻上游语义

初版实现自行设计了"整块切分 + 尾部补齐"，与上游不一致，导致 **max|diff| = 1.33**。

上游真实语义（`beat_this/inference.py`）：

```python
# split_piece
starts = arange(-border_size, T - border_size, chunk_size - 2*border_size)   # 步长不是 chunk_size!
if avoid_short_end and T > chunk_size - 2*border_size:
    starts[-1] = T - (chunk_size - border_size)      # 末块左移，恰好覆盖结尾
# 首块左零填充 border，末块右零填充 border

# aggregate_prediction
pred_chunks = [p[border_size:-border_size] ...]      # 每块切掉前后各 border 帧
if overlap_mode == "keep_first":
    items = reversed(list(zip(starts, pred_chunks))) # 逆序写入，早的覆盖晚的
```

**教训：ONNX 只导出模型的 `forward`。所有围绕它的分块/聚合/后处理都是纯 Python 逻辑，
必须逐行对照源实现移植，不能凭理解重写。** 这类错误不会崩，只会让结果静默错掉。

---

## A.3 后处理接口

`Postprocessor.__call__(beat, downbeat, padding_mask)` 接受 **1D** 张量，
`padding_mask` 应为**全 True**（更早的版本传了 `[None]` 变成 3D 导致 `einops` 报错）。

---

## A.4 真实音频解码：必须容忍尾部损坏

### 实测

该 FLAC 的 header 声明 337.92s，但尾部数据损坏。`libsndfile` 抛
`flac decoder lost sync`，且**会丢弃整个读块**：

| 读块大小 | 能成功读出的长度 |
|---|---|
| 5 s | **335.00 s** |
| 10 s | 330.00 s |
| 60 s | 300.00 s |
| 600 s | **0 s** |

### 结论（写入 M2 音频解码规范）

> **解码器必须返回「完好前缀 + 警告」，而不是整首失败；且必须用小读块（≤5s）
> 以最大化可恢复长度。**

这是真实音乐库的常态（下载中断、抓轨错误、metadata 与实际数据不符）。
用户会非常反感"这首歌打不开"却不知道为什么。

---

## A.5 端到端结果（真实音频）

### 数值一致性

| 路径 | 全曲耗时（12 块，335s 音频） | vs torch | 拍点位置差异 |
|---|---|---|---|
| torch CPU（上游实现） | 4280 ms | — | — |
| ORT CPU | 7297 ms | 4.58e-05 | — |
| **ORT CUDA** | **543 ms** | 3.12e-02 | **max = 0.000000 s** ✅ |

- **CUDA vs torch CPU 加速 ≈ 7.9x**
- 注意 ORT CPU 反而比 torch CPU 慢 1.7x（ONNX 在小批量下有额外开销），所以**要么用 CUDA，要么直接用 torch**（但产品里没有 torch）
- CUDA 的 3.12e-02 差异是 fp32 归约顺序导致，**不影响后处理后的拍点位置**（完全一致）

### 音乐合理性验证

```
曲长 335.00s | 417 拍 | 118 小节
BPM: 中位 71.4  范围 [68.2, 157.9]
小节长度中位 3.320s ≈ 3.95 拍/小节   (→ 4/4)
```

前 16 拍的小节起点每 4 拍出现一次，间隔稳定 0.84s，**结果正确**。

### ⚠️ 发现真实存在的八度错误（octave error）

417 拍中 **56 拍是半拍（0.42s 而非 0.84s）**，集中在：

| 时间段 | 拍数 |
|---|---|
| 36.42s ~ 41.42s | 12 |
| 42.26s ~ 44.76s | 4（分散） |
| **47.26s ~ 59.74s** | **30** |
| 298.92s ~ 311.44s | 10 |

波形图（`neural/exported/beats_verify_30_55.png`）可见：36–60s 段落的红线落在波峰之间，
IOI 曲线从 0.84s 骤降到 0.42s（**恰好一半**）。

**这不是本项目的实现 bug，是模型在该段落（可能是 chorus 密集鼓点）的误判。**

> **对产品的意义**：这直接印证了 PRD §13 的风险项
> 「复杂 BPM 与模型误拍导致全轨漂移」，以及配套决策
> 「Beat Map 可人工修正 + Half/Double-time 手动选择」的**必要性**。
> 也说明 M4 的 `draft` 状态 + 人工校对流程不是可选项。

> **M4/M7 应增加**：Half/Double-time 的一键切换，且切换要**基于局部区间**而非全曲
> （本例中 36–60s 需要翻倍，其余段落不需要）。

---

## A.6 更新后的决定

| 项 | 原结论 | 现结论 |
|---|---|---|
| beat_this 可 ONNX 化 | ✅ | ✅ **已验证到底**（真实音频 + 拍点级一致） |
| 导出长度要求 | 必须 ≥ 运行长度 | **改为：默认 8192 硬上限，必须分块（chunk=1500）** |
| GPU 收益 | 20x（合成数据） | **7.9x（真实全曲，对比 torch CPU）** |
| 权重加载 | 未提及 | **必须用 `load_model("final0")`；`BeatThis()` 是随机初始化，会返回看似合理但完全错误的拍点** |

> 最后一条是踩过的坑：初版脚本用 `BeatThis()` 得到 2007 拍（360 BPM）、
> 1267 个"小节"，数值上 torch 与 ONNX 完全一致——**但全是噪声**。
> 数值一致性校验**不能发现权重错误**，必须做音乐合理性检查（BPM 范围、拍/小节比）。

---

## A.7 新增的自动化测试要求

```python
# 1. 序列长度边界
assert run_ok(export_len_model, T=8192)
# T>8192 走分块，不做单次推理

# 2. 分块聚合与上游逐帧一致
torch_pred = split_predict_aggregate(spect, chunk_size=1500, border_size=6, ...)
onnx_pred = split_predict_onnx(sess, spect, chunk=1500, border=6)
assert max|torch_pred - onnx_pred| < 1e-2      # CUDA
assert max|torch_pred - onnx_pred| < 1e-4      # CPU

# 3. 后处理后拍点位置完全一致
assert max|beats_torch - beats_onnx| < 1e-6

# 4. 音乐合理性（能抓住权重错误 / 严重误判）
assert 40 <= median_bpm <= 200
assert 2 <= median_beats_per_bar <= 8
assert abs(median_beats_per_bar - round(median_beats_per_bar)) < 0.3
```

第 4 条最关键——它是唯一能发现「权重加载错误」的检查。

## 附：可复现脚本（新增）

| 文件 | 用途 |
|---|---|
| `neural/e2e_beat_this.py` | 端到端（含鲁棒加载） |
| `neural/probe_onnx_limit.py` | 二分定位 8192 上限 |
| `neural/verify_rope_fix.py` | 验证 cache_max_seq_len 修改方案 |
| `neural/final_beat_this.py` | **最终版**：真实权重 + 正确分块 + 完整闭环 |
| `neural/plot_beats.py` | 拍点叠加到波形图，人眼验收 |

运行：

```bash
conda activate harmonize
python neural/final_beat_this.py "E:\音乐\Aimer - 六等星の夜.flac"
python neural/plot_beats.py "E:\音乐\Aimer - 六等星の夜.flac" 30 25
```

---

# 附录 B：第二首真实音频（完整无损文件）的对照实验

> 测试曲目：`E:\音乐\Aimer - Refrain.flac`（FLAC 44.1kHz 立体声，290.15s，**完整无损，三种读块大小均可读满**）
> 用途：与附录 A 的损坏文件做对照，排除尾部损坏对结论的干扰

## B.1 汇总结果

| 指标 | 结果 |
|---|---|
| 时长 | 290.15s（14508 帧 @ 50fps，10 个 chunk） |
| torch CPU 分块 | 3713.5 ms |
| ORT CPU 分块 | 7228.3 ms（`5.8e-05`） |
| **ORT CUDA 分块** | **515.1 ms**（`2.2e-02`）→ **7.2x** |
| 拍点位置差异 | **max = 0.000000 s** ✅ |
| 拍数 / 小节 | 386 拍 / 99 小节 |
| BPM 中位 | 78.95 |
| 小节长度 | 3.080s ≈ **4.05 拍/小节（4/4）** |

**跨曲目结论稳定**：两首歌都是 ~7–8x 加速、拍点完全一致、清晰正确的 4/4。

## B.2 新发现 1：帧栅格量化导致的 IOI 抖动（不是错误）

完整无损文件反而暴露了一个附录 A 未观察到的问题：**IOI 不是单一值**。

### 实测分布（386 拍，385 个间隔）

| IOI | 帧数 | 出现次数 |
|---|---|---|
| 0.76s | 38 帧 | **168** |
| 0.78s | 39 帧 | **161** |
| 0.74s | 37 帧 | 12 |
| 0.80s | 40 帧 | 10 |
| 0.68s | 34 帧 | 9 |
| 0.70s | 35 帧 | 4 |
| 0.08s | **4 帧** | 11（异常，见 B.3） |
| 0.10s | **5 帧** | 4（异常） |

**92.2% 的 IOI 落在中位数 ±1 帧（0.02s）以内。**

### 根因

beat_this 输出是 **50 fps**（`hop_length=441 / 22050`），帧间隔 **0.02s**。
真实 BPM 约 78.1，换算拍长 ≈ 0.768s —— **正好落在 38 帧(0.76s) 和 39 帧(0.78s) 之间**。

模型只能二选一，所以相邻拍在 0.76 / 0.78 之间来回跳，近似 1:1 分布。

> **这不是模型缺陷，是量化分辨率的上限。**
> 50fps 的时间分辨率意味着：BPM 在 75–80 区间时，1 帧误差 ≈ 2% 拍长。

### 对产品的意义（重要）

PRD A01 要求「所有事件存整数 Tick（960 PPQ）」。如果直接把 0.76/0.78s 的拍点转成 Tick：

- 0.76s vs 0.78s 的差异在 960PPQ 下是**几拍 Tick**（取决于 BPM）
- 若用户看到拍点在小节内"抖动"，会认为工具不准

**处理建议（写入 M4/M7 规范）**：

1. 模型输出（`draft` 状态）**保留原始秒数**，不做任何美化（PRD §6.2 已要求）
2. 人工确认后，用一个**局部常速拟合**（例如按小节内的中位 IOI 归一化）生成 BeatMap 锚点
3. **不要跨段落做全局 BPM 固定** —— 这首歌整体恒速尚且抖动，有变速的曲子会更糟

## B.3 新发现 2：相邻重复峰（可以也应该清理）

### 现象

15 处间隔为 **0.08s（4 帧）或 0.10s（5 帧）** 的"双拍"，波形图上能看到**两根红线几乎贴在一起**。

分布段落：108.0s、163.5s、172.7s、175.7s（3 处）、176.5s、177.2s、251–267s（多段）。

### 根因

`Postprocessor.postp_minimal` 的逻辑：

```python
# 在 ±70ms（7 帧）内取局部极大值
pred_peaks = pred_logits.masked_fill(
    pred_logits != F.max_pool1d(pred_logits, 7, 1, 3), -1000
)
pred_peaks = pred_peaks > 0        # 只保留 logit > 0（概率 > 0.5）的峰
```

在**能量糊成一片的段落**（失真吉他墙、密集鼓），logits 会形成平台（plateau），
`max_pool1d` 在平台内会保留**多个相邻的"极大值"**，于是产生 4–5 帧间隔的多峰。

### 清理方案（已验证）

```python
# 相邻过近的峰只保留 logits 最高的那个
# min_ioi = 0.25s（约 240 BPM，超过就不像真实拍点）
# 注意：这是"去重"，不是"修正节拍结构"
```

实测效果：

```
原 386 拍 -> 去重后 371 拍（去掉 15 个）
IOI: min 0.680s / 中位 0.760s / max 0.860s
每小节拍数分布: {4: 87, 1: 5, 3: 4, 2: 3}
```

**去重后 4 拍/小节的比例从 84% 提升到 88%**，小节结构更规整。

> ⚠️ 剩余 12 个小节不是 4 拍，是**曲首/曲尾/过渡段的不完整小节**（正常现象），
> 以及 downbeat 检测在段落边界的小偏移。这与八度错误无关。

### 与附录 A 的区别

| | 附录 A (六等星の夜) | 附录 B (Refrain) |
|---|---|---|
| 半拍错误（0.42s） | **56 拍**，连续 30 拍 | **0 拍** |
| 相邻重复峰（0.08s） | 未统计 | **15 处** |

**两种错误类型完全不同、互斥**：
- A 是**节拍层级判断错**（八度错误）→ 需要用户手动 Half/Double-time
- B 是**同一拍内的重复检测**（plateau 多峰）→ 可以**自动去重**

**产品启示**：后处理需要两个独立的清理步骤，且只有第二个可以自动化。

## B.4 更新后的后处理规范（写入 M4）

```
1. 模型输出逐帧 logits（不做裁剪）
2. Postprocessor.minimal 提取峰
3. 【新增】相邻峰去重：IOI < 0.25s 的簇只保留 logit 最大者
4. 输出 draft 拍点（保留原始秒数）
5. 用户校对时：
   - 局部区间 Half/Double-time 切换（处理八度错误）
   - 帧栅格抖动不做自动修正（交由 BeatMap 锚点拟合吸收）
6. 确认后生成 BeatMap
```

> **第 3 步是本次新增的必需步骤**，上游 `beat_this` 没有做（它假定输入是干净的主流流行乐）。

## B.5 可复现

```bash
conda activate harmonize
python neural/final_beat_this.py "E:\音乐\Aimer - Refrain.flac"
python neural/clean_beats.py          # 帧栅格分析 + 重复峰去重
python neural/plot_beats.py "E:\音乐\Aimer - Refrain.flac" 170 20
```

---

# 附录 C：lv-chordia ONNX 完整验证（V2 结案）

> 测试曲目：`E:\音乐\Aimer - Refrain.flac`（290.15s，完整无损）
> 脚本：`neural/export_lv_chordia.py`、`neural/e2e_lv_chordia.py`

## C.1 结论先行

| 问题 | 结论 |
|---|---|
| **Q1：含 Bidirectional LSTM 的 ChordNet 能导出吗？** | ✅ **能**，一次成功 |
| **Q2：动态 T 可用吗？** | ✅ **完全可用**，T=100/512/2000/12496 全部正常 |
| **Q3：数值一致吗？** | ✅ 单模型 CPU `7.9e-04`，ensemble 平均 `2.8e-04` |
| **Q4：HMM 解码结果一致吗？** | ✅ **139/139 段，100% 完全一致** |
| **Q5：性能如何？** | ORT CUDA 2.4s vs torch CPU 3.8s（全曲 5 模型） |

**V2 从"有条件通过"升级为"已通过"。**

## C.2 模型事实（修正正文的表）

| 项 | 实测值 |
|---|---|
| 参数量 | **500,772**（ChordNet，含 BiLSTM） |
| 权重文件 | 5.7 MB × **5 个**（s0–s4 ensemble） |
| ONNX 体积 | **1.89 MB / 个**（ensemble 共 9.5 MB） |
| 输入 | **`cqt (T, 288)` float32** —— 注意是 **2D**，batch 维在模型内加 |
| 输出 | 6 个头，**已在图内做 softmax**：`(1,T,73)` `(1,T,13)` `(1,T,4)` `(1,T,4)` `(1,T,3)` `(1,T,3)` |
| 采样率 / hop | 22050 Hz / 512 → **43.07 fps** |

> **修正正文 §4.1 的两个细节**：
> 1. `SPEC_DIM=252` 的切片 `x[:, 18:270]` **应该放进 ONNX 图内**（输入直接给 288 维 CQT），
>    而不是要求前处理先切。这样 Rust 侧只需算完整 CQT。
> 2. softmax 保留在图内，Rust 侧拿到的就是概率，不用重复实现。

## C.3 导出配方（已验证可用）

```python
class ChordNetExport(torch.nn.Module):
    def forward(self, cqt):                 # cqt: (T, 288)
        cqt = cqt.unsqueeze(0)              # -> (1, T, 288)
        x = cqt[:, :, 18:18+252]            # 切出 252 维
        h = self.net.audio_feature_block(x) # CNN -> (1, T, 240)
        hd = self.net.hidden_dim1 // 2
        z = torch.zeros(2, 1, hd, dtype=h.dtype, device=h.device)
        h1 = self.net.lstm1(h, (z, z.clone()))[0]   # BiLSTM
        y = self.net.final_fc1(h1).reshape(1*T, 100)
        # ... 按 chord_limit 切片成 6 头 ...
        return tuple(torch.softmax(hh.reshape(1, T, -1), dim=-1) for hh in heads)

torch.onnx.export(..., opset_version=17, dynamo=False,
    dynamic_axes={"cqt": {0: "time"},
                  "triad": {0: "time"}, ...})   # 只标 0 维（time）
```

### ⚠️ 上游代码的两个隐患（必须处理）

**隐患 1：`init_hidden` 用固定 device**

```python
# chordnet_ismir_naive.py
c_0 = torch.zeros(2, batch_size, hidden_dim//2).to(self.device)   # self.device 是构造时定死的
```

在 CUDA 上跑会报：

```
RuntimeError: Input and hidden tensors are not at the same device,
found input tensor at cuda:0 and hidden tensor at cpu
```

**对策**：导出 wrapper 里**自己按输入设备构造 hidden**，不要调 `init_hidden`。

**隐患 2：`NetworkInterface.inference` 返回 (T, C)，但 ONNX 返回 (1, T, C)**

对比时极易写错（本人踩了两次）：

```python
# ❌ 错：t[k][0] 是第 0 帧；t[k][0:1] 是 1 行
max(abs(t[k][0:1] - o[k][0]))          # -> 9.8e-01 的虚假差异
# ✅ 对：整段 vs 去掉 batch 维
max(abs(np.asarray(t[k]) - o[k][0]))   # -> 7.9e-04
```

> **教训：数值校验代码本身必须先验证形状，再比较数值。**
> 一个 index 错误就能凭空造出 1e0 量级的"误差"，让人误以为模型转换失败。

## C.4 真实音频端到端结果

### 耗时（290s 全曲，12496 帧）

| 阶段 | 耗时 |
|---|---|
| **CQT（首次，含 numba JIT 编译）** | **18.1 s** |
| **CQT（第二次起）** | **3.2 s** |
| CQT（30s 分块 ×10） | **0.8 s** |
| 5 模型 ensemble — torch CPU | 3.8 s |
| 5 模型 ensemble — ORT CPU | 5.5 s |
| **5 模型 ensemble — ORT CUDA** | **2.4 s** |
| HMM 解码 | 未单独计时（很快） |

> **关键发现：CQT 首次运行慢 6 倍是 numba 的一次性 JIT 编译开销。**
> 18.1s → 3.2s。这解释了实测中"同一次 `hybrid_cqt` 两次跑差 6 倍"的疑问。
>
> **对 Rust 实现的意义**：纯 Rust 的 CQT 没有 JIT 预热问题，反而比 Python 首次调用快得多。
> 但 Rust 必须精确复现 librosa 的 CQT（尤其是 `bins_per_octave=36` 的非整数倍频程与
> `fmin=F#0` 的滤波器组构造），这是**目前工作量最大的一块**。

### 数值一致性

| 对比 | max\|diff\| |
|---|---|
| torch wrapper vs torch 原版 inference | **0.000e+00**（完全等价） |
| 单模型 s0：torch vs ORT CPU | 7.86e-04 |
| 单模型 s0：torch vs ORT CUDA | 1.44e-03 |
| **ensemble 平均：torch vs ORT CPU** | **2.77e-04** |
| ensemble 平均：torch vs ORT CUDA | 3.79e-04 |

### 最终结果一致性

```
torch:  139 个和弦段
ONNX :  139 个和弦段
段级完全一致: 139/139 (100.0%)
```

**HMM 解码后完全一致 —— 这是产品真正关心的那一层。**

## C.5 和弦识别质量（音乐合理性）

### 检出结果

```
曲长 290.15s | 139 段 | 18 种和弦
Top: D:maj(32) C:maj(32) E:min7(24) G:maj(21) D:7(5) E:min(5) A:min7(3)
```

### 与拍点结果的交叉验证 ✅

这是一个**很有价值的独立验证**：

- `beat_this` 判定：BPM 78.95，**4/4 拍**
- `lv-chordia` 判定：和弦按 ~3s 一段推进，主要进行是 **G – D – E:min7 – C**（前 60 秒）

**G–D–Em–C 正是流行乐最经典的 I–V–vi–IV 进行**（G 大调）。
和弦段的边界与 beat_this 的小节边界在量级上一致（每 2 小节换一次和弦）。

> 两个独立模型在同一首歌上给出互相自洽的音乐解释，
> 说明**整条链路（前处理 → 模型 → 后处理）都是正确的**。

### 已知局限

- 首段 `0.00 ~ 0.42 N`（"无和弦"）：intro 前的静音，正常
- 出现 `D:maj/3`（第一转位）、`C:maj/5`、`E:min/b3`：说明**低音识别在工作**，这正是
  `lv-chordia` 相对简单 chroma 模板匹配的核心优势（它有独立的 bass 头）
- 大七和弦 `C:maj7`/`G:maj7` 各 2 段，数量偏少 —— J-Pop 中小七和弦多，大七和弦本来就少，合理

## C.6 对 M7 的影响（修正）

| 项 | 原计划 | 修正后 |
|---|---|---|
| ChordNet vs ChordNetCNN | 建议用 CNN 版避开 LSTM | **不必**。LSTM 版导出成功且动态 T 正常，**直接用 ChordNet** |
| ONNX 体积 | 未知 | **1.89 MB × 5 = 9.5 MB**（很小） |
| ensemble | 未明确 | **必须用 5 个模型**（精度靠 ensemble 平均；单模型差异 7.9e-04 会在 HMM 边界放大） |
| 前处理 | "Rust 重写 CQT" | **仍是最大工作量**。CQT（bins_per_octave=36, n_bins=288, fmin=F#0）比 beat_this 的 mel 难得多 |
| 推理性能 | 未测 | ORT CUDA 2.4s/5 模型，可接受；不需额外优化 |

## C.7 更新后的 M7 任务清单

```
7.x-1  Rust CQT 实现（最大工作量）
       - 必须精确复现 librosa.hybrid_cqt 的滤波器组
       - 用 Python 导出的 CQT 张量做逐元素断言（阈值 1e-4）
       - 建议先在 Python 侧导出「黄金 CQT」：对测试曲目保存 (T,288) 的 .npy
7.x-2  导出 5 个 ONNX（ChordNet，非 CNN 版），图内含切片 + softmax
7.x-3  Rust 侧 XHMM 解码器移植
       - 读 submission_chord_list.txt 模板
       - 实现 decode_to_chordlab
       - 用「139 段完全一致」作为验收基准
7.x-4  拍点与和弦的时间对齐（43.07 fps vs 50 fps，需按秒对齐而非帧号）
```

> **特别注意 CQT 与拍点的帧率不同**：
> - `beat_this`: 22050/441 = **50 fps**
> - `lv-chordia`: 22050/512 = **43.07 fps**
>
> 两者落在同一时间轴时必须**按秒换算**，不能按帧号映射。

## C.8 可复现

```bash
conda activate harmonize
python neural/export_lv_chordia.py                      # V2 核心验证（合成输入）
python neural/e2e_lv_chordia.py "E:\音乐\Aimer - Refrain.flac"   # 真实音频端到端
```

产物：`neural/exported/lv_chordia_s0..s4.onnx`、`chords_torch.json`

---

# 附录 D：黄金测试数据（Rust 前处理的验收基准）

> 脚本：`neural/make_golden.py`　产物：`neural/exported/golden/`（1.82 MB）

## D.1 为什么需要它

M7 剩下的最大工作量是 **Rust 重写 CQT 和 mel 前处理**。这类实现的危险在于：

- 算错了**不会崩**，只会让模型精度悄悄下降
- 滤波器组的构造细节（Slaney vs HTK、periodic window、padding 模式）任何一处不同都会导致特征分布偏移

所以唯一的验收手段是：**同一段音频，Rust 算出的张量必须与 librosa/torchaudio 逐元素接近。**

## D.2 内容清单

以「Refrain 的 60–70s 片段」为例，产物 1.82 MB：

| 文件 | 形状 | 大小 | 用途 |
|---|---|---|---|
| `wave_22050.npy` | (220500,) f32 | 861 KB | 输入波形（已重采样到 22050） |
| `cqt_288.npy` | (431, 288) f32 | 485 KB | **CQT 目标输出** |
| `mel_128.npy` | (501, 128) f32 | 251 KB | **mel 目标输出** |
| `mel_filterbank_513x128.npy` | (513, 128) f32 | 257 KB | mel 滤波器组矩阵（Rust 直接用） |
| `hann_1024.npy` | (1024,) f32 | 4 KB | 窗函数（**periodic=False**） |
| `cqt_freqs_288.npy` | (288,) f32 | 2 KB | 每个 bin 的中心频率 |
| `cqt_lengths_288.npy` | (288,) i32 | 1 KB | 每个 bin 的滤波器时域长度 |
| `cqt_lengths_36.npy` | (36,) i32 | 0.3 KB | hybrid_cqt 低频段长度 |
| `manifest.json` | — | 2 KB | 全部参数与断言阈值 |

> 滤波器组本体 `cqt_filters_padded288.npy` 为 **288 × 49530 complex64 = 108.8 MB**，默认不落盘。
> 需要时设 `SAVE_CQT_FILTERS=True`。

## D.3 关键参数（务必逐项核对）

### CQT（lv-chordia）

```
librosa.core.hybrid_cqt(
    y, sr=22050, hop_length=512, fmin=23.124651 (F#0), n_bins=288,
    bins_per_octave=36, tuning=0.0, filter_scale=1, norm=1,
    sparsity=0.01, window='hann', scale=True,
    pad_mode='constant', res_type='soxr_hq',
)
→ np.abs(result).T  → (T, 288) float32
```

- 帧率：22050 / 512 = **43.07 fps**
- 频率范围：23.12 Hz ~ 5807.02 Hz
- 滤波器长度：**197 ~ 49530 采样点**（低频 bin 的窗长达 2.2 秒！）
- `hybrid_cqt` 会**分两段计算再拼接**：低频段用更长的窗，高频段用短窗

> ⚠️ `tuning=None` 传入后实际生效为 `tuning=0.0`（librosa 内部把 None 当 0）。
> 这意味着**不做调音估计**，用标准 A440 网格。

### mel（beat_this）

```
torchaudio.transforms.MelSpectrogram(
    sample_rate=22050, n_fft=1024, hop_length=441, win_length=1024,
    f_min=30, f_max=11000, n_mels=128,
    mel_scale='slaney', norm='frame_length', power=1,
)
窗口 = torch.hann_window(1024, periodic=False)   ← 注意 periodic=False！
输出 = log1p(1000 * mel)  → (T, 128)
```

- 帧率：22050 / 441 = **50 fps**
- `power=1` → **幅度谱**，不是能量谱
- 滤波器组形状 `(n_fft//2+1, n_mels)` = **(513, 128)**

## D.4 断言阈值建议

| 对象 | 阈值 | 理由 |
|---|---|---|
| STFT 中间结果（complex64） | `< 1e-4` | 纯 FFT，差异只来自 float32 |
| mel 输出（log1p 之后） | `< 1e-3` | 有 log，数值被压缩 |
| **CQT 输出** | `< 1e-3` | 累积误差较大（多种窗长拼接） |
| 模型 logits（喂同一份前处理） | `< 1e-3` | 已在 ADR 附录 C 验证 ORT 与 torch 的差异在此量级 |

## D.5 复现

```bash
conda activate harmonize
python neural/make_golden.py "E:\音乐\Aimer - Refrain.flac" 60 10
# 参数：音频路径  起始秒  时长秒
```

建议生成 **3–5 段不同材料**（安静段落 / 密集鼓点 / 高音区 / 低音区），
避免只在一种音频特征上"碰巧对上"。

---

# 附录 E：M0-V2/V3 总体结案

## E.1 验证矩阵

| 项 | 模型 | 状态 | 关键数据 |
|---|---|---|---|
| **V2** | lv-chordia (ChordNet, CNN+BiLSTM) | ✅ **通过** | 单个 1.89 MB；ensemble 平均差异 2.8e-04；**HMM 139/139 段一致** |
| **V3** | beat_this (Transformer+RoPE) | ✅ **通过** | 83 MB；CUDA vs torch 差异 3.1e-02；**拍点位置 0.000000s 差异** |

## E.2 共同的技术风险模式（三个都踩过）

| 模式 | 表现 | 通用对策 |
|---|---|---|
| **Python 侧属性被 trace 成常量** | RoPE `cached_freqs_seq_len` 固化 → 超出 8192 后静默错误 | 导出时序列长度 ≥ 运行最大值，或走分块；**用二分法探测上限** |
| **前处理/后处理不在图内** | CQT、mel、peak picking、HMM 都是纯 Python | 必须逐行移植 + 黄金数据断言，**不能凭理解重写** |
| **数值校验代码自身出错** | 一个 index 错误造出 1e0 的虚假差异 | **先验证形状，再比数值**；同时做「上限/下限」两个极端用例 |

## E.3 M7 剩余工作（已清晰）

```
1. Rust CQT 实现（最大工作量，~1–2 周）
   - 起点：cqt_freqs / cqt_lengths / mel_filterbank / hann 已导出
   - 验收：与 cqt_288.npy 逐元素 < 1e-3
2. Rust mel + STFT（~2–3 天，比 CQT 简单）
   - 验收：与 mel_128.npy 逐元素 < 1e-3
3. Rust XHMM 解码器移植（~3–5 天）
   - 读 submission_chord_list.txt
   - 验收：139/139 段完全一致
4. 分块聚合移植（beat_this 的 split_piece / aggregate_prediction）
   - 验收：与上游逐帧一致
5. 拍点去重（新增，上游没有）
   - IOI < 0.25s 的簇保留 logit 最大者
```

## E.4 建议的下一步

**M7 不再是"可选"** —— 两个模型都验证可行且收益明确。真正的成本在 Rust 侧前处理。

建议 M7 开工顺序（按风险从高到低）：

1. **Rust CQT** —— 唯一还没有任何验证的高风险项
2. Rust XHMM 移植 —— 纯算法，但需要精确对照
3. Rust mel + STFT —— 低风险
4. 分块聚合 + 拍点去重 —— 逻辑已完全清楚，只是照抄

> 也可以考虑一个**降级方案**：如果 Rust CQT 精度始终达不到 `< 1e-3`，
> 可以把 CQT 做成一张**预计算矩阵的 FFT**（黄金数据已含滤波器的关键常数），
> 或者退一步接受 `< 1e-2` 并要求 HMM 解码结果仍然一致（用 139/139 作为最终验收）。
