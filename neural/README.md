# neural/ — 神经网络模型实验区

> ⚠️ **本目录仅供开发期实验，永不进入任何分发产物。**
> 产品运行时不依赖 Python；这里的代码只用于：模型的 ONNX 化、黄金测试数据生成、精度评估。

---

## 环境

已创建 conda 环境：**`harmonize`**（Python 3.11.18）

```bash
# 在本机（git-bash）里激活
export PATH="/c/miniconda3/Scripts:/c/miniconda3:$PATH"
source /c/miniconda3/Scripts/activate harmonize
```

| 组件 | 版本 |
|---|---|
| torch | 2.11.0+**cu128** |
| onnxruntime-gpu | 1.31.1 (CUDA / TensorRT / CPU EP) |
| librosa | 0.11.0 |
| numpy | 2.4.6 |
| onnx | 1.23.2 |

> 🔴 **RTX 50 系列（sm_120）必须用 cu128 及以上的 torch。**
> 用 cu118/cu121 会报 `no kernel image is available for execution on the device`。
> 验证命令见下方「环境自检」。

### 环境自检

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_capability(0), torch.cuda.get_arch_list())"
# 期望：2.11.0+cu128 True (12, 0) [... 'sm_120']
```

---

## 目录内容

| 路径 | 说明 |
|---|---|
| `lv-chordia/` | 和弦识别（ISMIR 2019 Large-Vocabulary Chord Recognition），MIT |
| `beat_this/` | 拍点识别（CPJKU Beat This!），MIT |
| `all-in-one-infer/` | 段落/节拍一体分析，MIT（**评估后暂不接入**，见 ADR-0001） |
| `exported/` | ONNX 导出产物（git 忽略） |
| `probe_models.py` | 打印模型结构 / 输入输出形状 / 前处理参数 |
| `probe_onnx_limit.py` | 二分定位 8192 序列长度上限 |
| `verify_rope_fix.py` | 验证 cache_max_seq_len 修改方案 |
| `final_beat_this.py` | **最终版**：真实权重 + 正确分块 + 完整闭环 |
| `plot_beats.py` | 拍点叠加到波形图，人眼验收 |
| `clean_beats.py` | 帧栅格分析 + 相邻重复峰去重 |
| `export_lv_chordia.py` | 和弦模型 ONNX 导出 + 数值/性能验证 |
| `e2e_lv_chordia.py` | 和弦端到端：CQT → 5 模型 → HMM |
| `make_golden.py` | 生成黄金测试数据（供 Rust 前处理断言） |
| `verify_chord_dicts.py` | 三档 chord dictionary 对比 |
| `probe_local_redecode.py` | 局部重解码的 pad 与一致性 |
| `probe_pad_min.py` | 最小 pad 精测 |

## 和弦档位（Chord Dictionary）

**三档共用同一份网络输出，只是三套 HMM 解码模板** —— 切档不需要重跑 CQT 和模型。

| 档位 | 模板行数 | 全曲 HMM 耗时 | 定位 |
|---|---|---|---|
| **submission**（默认） | 25 | **241 ms** | 通用，最佳平衡 |
| ismir2017 | 14 | 136 ms | 研究对比，**抹掉转位/低音** |
| full | 381 | 2037 ms | 爵士、复杂和声 |

实测差异（前 20 秒）：

```
submission:  ... G:maj | D:maj/3 | E:min7 | D:maj | C:maj/5 | ...
ismir2017:   ... G:maj |   (合并) | E:min7 | D:maj | C:maj   | ...
```

**档位差异 = 记谱精细度（转位/低音是否保留），不是和弦判断变化。** UI 必须说明这一点。

## 局部重绘（局部重新分析）

用户框选任意区间 → 选档位 → 重解码 → 覆盖 或 保留其一。

**pad 实测结论（推翻了初版判断）**：

| pad | 不一致帧 | 错误位置 |
|---|---|---|
| 0.0 | 2 帧（0.3%） | 距左端 **0.00–0.02s** |
| 0.5 | 0 | — |

- 误差**只出现在区间起点** 1–2 帧（20–40 ms）
- **Viterbi 是前向的，右端从不出错**
- 采用**前后对称各 2s**（前置就够，对称是为视觉一致性与边界安全）

详见 `docs/adr/0002-chord-dictionary-and-local-rewrite.md`。

---

## 快速开始

```bash
export PATH="/c/miniconda3/Scripts:/c/miniconda3:$PATH"
source /c/miniconda3/Scripts/activate harmonize
cd /f/Repo/musicAnaz

python neural/probe_models.py        # 看模型结构
python neural/final_beat_this.py AUDIO # 端到端（推荐入口）
python neural/plot_beats.py AUDIO 30 25   # 画图验收
```

> 首次运行 `final_beat_this.py` 会从 `cloud.cp.jku.at` 下载 `final0.ckpt`（约 230 MB）。

### 真实音频踩到的坑（详见 ADR-0001 附录 A）

| 坑 | 现象 | 对策 |
|---|---|---|
| FLAC 尾部损坏 | `flac decoder lost sync`，整首无法加载 | **5 秒小块读取**，返回「完好前缀 + 警告」。实测 5s 块能读 335s，60s 块只剩 300s，600s 块完全读不出 |
| RoPE 8192 上限 | `invalid expand shape` | 按 chunk=1500 分块 |
| 自行设计分块聚合 | `max abs diff = 1.33` | 逐行复刻上游 `split_piece` / `aggregate_prediction` |
| 随机初始化权重 | 2007 拍 / 360 BPM，但 torch 与 ONNX「完全一致」 | 必须 `load_model("final0")`；增加音乐合理性断言 |
| 八度错误 | 56/417 拍是半拍（0.42s 而非 0.84s） | 模型真实局限，UI 需提供**局部区间**的 Half/Double-time 切换 |
| 帧栅格抖动 | IOI 在 0.76/0.78s 之间来回跳（各占约一半） | 50fps 量化的必然结果。**不要自动修正**，交给 BeatMap 锚点拟合吸收 |
| 相邻重复峰 | 0.08s / 0.10s 的「双拍」，波形上两根线贴在一起 | `max_pool1d` 在糊段落留下的 plateau 多峰。**必须自动去重**（`clean_beats.py`） |

### 黄金测试数据（Rust 前处理的唯一验收基准）

```bash
python neural/make_golden.py <音频路径> 60 10   # 起始秒 时长秒
```

产物 `neural/exported/golden/`（1.82 MB）：

| 文件 | 用途 |
|---|---|
| `wave_22050.npy` | 输入波形 |
| `cqt_288.npy` | **CQT 目标输出**（Rust 断言小于 1e-3） |
| `mel_128.npy` | **mel 目标输出**（Rust 断言小于 1e-3） |
| `mel_filterbank_513x128.npy` | mel 滤波器组，Rust 直接用 |
| `hann_1024.npy` | 窗函数，注意 **periodic=False** |
| `cqt_freqs_288.npy` / `cqt_lengths_288.npy` | CQT 每 bin 的中心频率与滤波器长度 |
| `manifest.json` | 全部参数 + 断言阈值 |

建议生成 3-5 段不同材料（安静段 / 密集鼓点 / 高音区 / 低音区），避免只在一种音频特征上碰巧对上。

### 两首真实曲目的对照（附录 A / B）

| | 六等星の夜 | Refrain |
|---|---|---|
| 时长 / 完整性 | 337.92s 声明，**335s 可读**（尾部损坏） | 290.15s **完整无损** |
| 文件读取 | 必须 5s 小块 | 任意块大小均可 |
| 拍 / 小节 | 417 / 118 | 386 / 99 |
| BPM 中位 | 71.4 | 78.95 |
| 拍/小节 | 3.95 → 4/4 | 4.05 → 4/4 |
| CUDA 加速 | 7.9x | 7.2x |
| **半拍错误** | **56 拍**（含连续 30 拍） | **0 拍** |
| **相邻重复峰** | 未统计 | **15 处** |

> 两种错误类型**互斥**：A 是节拍层级判断错（需人工切换），B 是同一拍内重复检测（可自动去重）。

---

## 已确认的关键事实（详见 `docs/adr/0001-neural-onnx-feasibility.md`）

### beat_this ✅ 可 ONNX 化

| 项 | 值 |
|---|---|
| 参数量 | 20.25 M（81 MB fp32） |
| 输入 | `spect (B, T, 128)` float32 |
| 输出 | `beat_logits (B,T)`, `downbeat_logits (B,T)` |
| 前处理 | `LogMelSpect(sr=22050, n_fft=1024, hop=441, mels=128, slaney, power=1)` → `log1p(1000*x)` |
| 精度（分块全曲） | CPU EP `4.6e-05` / CUDA EP `3.1e-02`，**后处理拍点位置完全一致** |
| 性能（335s 全曲） | torch CPU 4280 ms → **ORT CUDA 543 ms（7.9x）** |
| 真实音频结果 | 417 拍 / 118 小节 / BPM 中位 71.4 / **3.95 拍每小节（4/4）** |

**🔴 铁律一：RoPE 有硬编码上限 8192，必须分块推理。**

`rotary_embedding_torch` 源码 `cache_max_seq_len = 8192`（固定常量，与导出长度无关）：

- `T <= 8192` → 走缓存分支，trace 成 ONNX `Slice`，任意长度都正常
- `T > 8192` → 走重算分支，trace 时 T 被固化 → `invalid expand shape` 报错

实测（二分确认）：导出 1600 和 8000 的模型**都是 8192 OK / 8193 FAIL**。
即使把 `cache_max_seq_len` 调大，T>=12000 也会 `bad allocation`（注意力 O(T^2)）。

→ **按上游 `chunk_size=1500, border_size=6` 分块**，这不是优化而是必须。

**🔴 铁律二：分块聚合必须逐行复刻上游，不能凭理解重写。**

自研的「整块切分」与上游差异导致 `max|diff| = 1.33`。上游关键细节：

- `split_piece` 步长是 `chunk_size - 2*border_size`（不是 chunk_size），首尾零填充，末块左移覆盖结尾
- `aggregate_prediction` 每块切掉前后各 border 帧，`keep_first` 逆序写入

**🔴 铁律三：必须用 `load_model("final0")`，不能用 `BeatThis()`。**

`BeatThis()` 是随机初始化。实测得到 2007 拍（360 BPM）、数值上 torch 与 ONNX 完全一致——
**但全是噪声**。数值一致性校验**发现不了权重错误**。

### lv-chordia ⚠️ 有条件可 ONNX 化

- 优先导出 **`ChordNetCNN`**（纯 CNN，211 K 参数，每帧独立、可流式分块）
- 避免 `ChordNet`（含 Bidirectional LSTM，500 K 参数，动态 T 上有 shape 推断风险）
- **前处理 `librosa.hybrid_cqt`（bins_per_octave=36, n_bins=288, hop=512）必须 Rust 重写**，比 mel 复杂得多
- 输出 6 个头的 softmax 概率：triad / bass / 7th / 9th / 11th / 13th

### lv-chordia ✅ 已验证（V2 结案）

| 项 | 值 |
|---|---|
| 模型 | `ChordNet`（CNN + **Bidirectional LSTM**）500,772 参数 |
| **LSTM 能否导出 ONNX** | ✅ **能**，动态 T 完全正常（T=100/512/2000/12496） |
| ONNX 体积 | **1.89 MB × 5**（s0–s4 ensemble） |
| 输入 | `cqt (T, 288)` float32 —— **2D**，batch 维在模型内加 |
| 输出 | 6 头，**图内已 softmax**：73/13/4/4/3/3 |
| 数值 | 单模型 `7.9e-04`、**ensemble 平均 `2.8e-04`** |
| **HMM 解码结果** | **139/139 段 100% 一致** ✅ |
| 性能（290s，5 模型） | torch CPU 3.8s → **ORT CUDA 2.4s** |
| 识别质量 | 检出 18 种和弦，前 60s 为 **G–D–Em–C**（I–V–vi–IV），与 beat_this 的 4/4 判定自洽 |

**前处理 CQT 是最大工作量**：`librosa.hybrid_cqt(bins_per_octave=36, n_bins=288, fmin=F#0, hop=512)`
比 beat_this 的 mel 难一个量级。

**⚠️ 两个上游隐患**：
1. `init_hidden` 用构造时定死的 `self.device` → 在 CUDA 上报 device 不匹配。导出 wrapper 里要自己按输入设备造 hidden。
2. `NetworkInterface.inference` 返回 `(T,C)`，ONNX 返回 `(1,T,C)` —— 对比时一个 index 错误就能造出 1e0 的虚假差异（本人踩了两次）。

**⚠️ 帧率不同**：beat_this 是 50fps，lv-chordia 是 **43.07fps**（22050/512）。对齐必须按秒，不能按帧号。

### all-in-one-infer ❌ 暂不接入

- 依赖链含 `demucs-infer`（源分离）+ `madmom-infer` + `hydra-core`，且是 git 依赖
- 要零 Python 就得把 demucs 也 ONNX 化，成本过高
- 拍点功能与 beat_this 完全重复
- **段落识别先用纯信号处理方案**（自相似矩阵 + 重复段检测）

---

## 状态

| 验证 | 状态 | 关键数据 |
|---|---|---|
| V2 lv-chordia | PASS | 1.89 MB/模型；ensemble 差异 `2.8e-04`；**HMM 139/139 段一致** |
| V3 beat_this | PASS | 83 MB；**拍点位置差异 0.000000s** |
| 黄金数据 | PASS | `exported/golden/` 1.82 MB |
| all-in-one-infer | 不接入 | 依赖链过重，段落用信号处理替代 |

## 下一步（M7 剩余工作）

- [ ] **Rust CQT 实现** <- 唯一还没验证的高风险项
- [ ] Rust mel + STFT（低风险，约 3 天）
- [ ] Rust XHMM 解码器移植（验收基准：139/139 段）
- [ ] 分块聚合移植（beat_this 的 `split_piece` / `aggregate_prediction`）
- [ ] 拍点去重（新增步骤，上游没有）
- [ ] DirectML EP 对两个模型算子集的覆盖验证

---

## 许可证

| 模型 | 许可证 |
|---|---|
| lv-chordia | MIT（代码与权重，需再次确认权重文件的再分发条款） |
| beat_this | MIT |
| all-in-one-infer | MIT（依赖的 demucs / madmom 需单独确认） |

> 分发前必须逐项确认**权重文件**的再分发许可（PRD §13 硬性要求）。
