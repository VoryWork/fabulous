# 开发环境搭建

> 面向新加入的开发者。目标是：**clone 完能跑，且知道每个外部依赖从哪来、为什么不在仓库里。**

---

## 0. 先看这张表：你需要哪条链路

项目里有**两条分析链路**，功能等价，但依赖天差地别。

| 链路 | 引擎 | 需要 Python？ | 谁是默认 |
|---|---|---|---|
| **Rust 原生** | `client/src-tauri/src/{audio,model,analysis}` + ONNX Runtime | ❌ 不需要 | ✅ 默认，发布版只走这条 |
| Python 对照 | `neural/analyze_song.py` + 4 个上游仓库 | ✅ 需要 | 仅排查 / 重生成 golden 用 |

**只做前端或 Rust** → 跳到 §2，不用装 Python 那一套。
**要动模型推理、要重导出 ONNX、要查「Rust 和 Python 结果为什么不一样」** → 还要 §3、§4。

前端/构建/测试命令见 [`client/README.md`](../client/README.md)。

---

## 1. 工具链

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Rust | **1.85+** | `client/src-tauri/Cargo.toml` 用了 `edition = "2024"` |
| MSVC 工具链 | VS 2022 Build Tools | Windows 下 `rusqlite`(bundled)/`ort` 都要 |
| bun | 1.2+ | 前端包管理与脚本 |
| WebView2 | Win10/11 自带 | 运行时 |

Python 链路额外需要 **Python 3.10+** 和 CUDA（可选，见 §3）。

---

## 2. Rust 链路（默认）

```bash
cd client
bun install

bun run dev         # 只跑前端，浏览器调时间轴（不需要 Rust 编译，最快）
bun run tauri dev   # 完整桌面窗口
```

### 模型文件：`assets/` 里有什么、缺什么

`client/src-tauri/assets/` **已入库**的部分（clone 就有）：

```
chord_vocab_submission.tsv / chord_vocab_ismir2017.tsv / chord_vocab_full.tsv   三档词表
mel_fb.f32                                                                     mel 滤波器组（include_bytes!）
golden_*.f32 / golden_*.tsv                                                    与 Python 逐值对齐的测试基准
```

**没有**入库、需要自己生成的部分：

```
client/src-tauri/assets/chord_fold0..4.onnx     5 折和弦模型（9.5 MB）
assets/beat_this_final.onnx                      拍点模型（80 MB）
```

它们被 `.gitignore` 的 `*.onnx` 挡住，理由是**可由脚本重新生成**且体积大。两种获取方式：

1. **从发布包取**（最快）：解压 `dist-zip` 里的 zip，把 `*.onnx` 拷到 `client/src-tauri/assets/`
2. **自己导出**（需要 Python 链路）：见 §4

> 缺模型的后果：`analyzer::build_analyzer()` 会退化到 Python 引擎；Python 也没有就是 `None`，界面上会提示「分析功能不可用」。
> 启动日志里出现 `[analyzer] Rust 引擎（ONNX，自包含）` 才算找齐。

### 测试

```bash
cd client
bun run test                      # 前端 330+ 用例
bun run typecheck

cd src-tauri
cargo test --lib                  # 92 个用例，含与 Python 逐值对齐的 golden 测试

# 性能探针（真实音频，打印每个进度点与阶段耗时）
cargo test --lib perf_progress_probe -- --ignored --nocapture
```

⚠️ **`cargo test` 必须能跑**：`audio/golden_tests.rs` 用 `include_bytes!` 编译期读 `assets/golden_*.f32`，
所以那些 golden 文件不能删、也不能加进 `.gitignore`（否则连编译都过不了）。

> `testdata/songs/*/audio.flac` **不在仓库里**（商业歌曲有版权）。少数 `#[ignore]` 的手动测试
> 需要音频时会打印提示并跳过；要跑就用环境变量指定自己的歌：
> `MUSICANAZ_TEST_AUDIO="D:/music/x.flac" cargo test --lib analysis::tests::dump_wave60 -- --ignored --nocapture`
>
> 想复现那三首的**具体数值**要自己准备原版录音（曲名/时长/放置路径见
> [`testdata/README.md`](../testdata/README.md)「自己准备音频」），放好后跑
> `python neural/check_testdata.py` 自检版本对不对。

⚠️ **dev 构建必须开优化**：`Cargo.toml` 里 `[profile.dev] opt-level = 1` +
`[profile.dev.package."*"] opt-level = 3`。删掉这几行的话，CQT / chroma 会慢 20~50 倍，
表现为「分析卡在计算 CQT 特征…，几分钟不结束」。实测同一首歌：优化后 22.8s，不优化单 CQT 就 >60s。

---

## 3. Python 链路（对照 / 重导出）

### 3.1 上游仓库：**不要改，也不要提交**

4 个上游仓库都通过 `git clone` 拉取，**整个目录被 `.gitignore` 排除**：

```gitignore
neural/lv-chordia/
neural/beat_this/
neural/all-in-one-infer/
neural/demucs-infer/
```

原因：它们是别人的仓库（体积 150 MB +），我们自己一行代码都没改。放进本仓库会让提交历史里
混入第三方代码，也没法同步上游更新。

一键拉取（会按下面的 commit 固定版本）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-upstream.ps1
```

脚本是幂等的：目录不存在就 clone，存在就 `fetch` + `checkout` 到锁定 commit。

### 3.2 版本锁（当前）

| 仓库 | remote | commit | 用途 | 权重怎么来 |
|---|---|---|---|---|
| `neural/lv-chordia` | `github.com/openmirlab/lv-chordia` | `d8ab9ac` | 和弦 5 折 ChordNet + XHMM 解码 | **仓库自带** `weights/*.sdict`（5 折，83 MB，上游刻意 bundle） |
| `neural/beat_this` | `github.com/CPJKU/beat_this` | `b95c8ab` | 拍点 / 小节 | 首次运行 `torch.hub.load_state_dict_from_url` **自动下载** |
| `neural/all-in-one-infer` | `github.com/openmirlab/all-in-one-infer` | `566f96c` | 段落结构 | 首次运行从 HuggingFace **自动下载**（缓存在 torch hub） |
| `neural/demucs-infer` | `github.com/openmirlab/demucs-infer` | `a8552bb` | 源分离（可选） | 自动下载 |

> 换版本前先跑 §3.5 的验证；commit 变了权重的行为也可能跟着变。

**唯一需要手动下载的权重**：`lv-chordia` 的**另一组** reweight 变体
（`reweight(0.3,10.0)` / `reweight(1.0,20.0)`），来自上游 README 里那个 Google Drive 链接，
放在 `neural/lv-chordia/weights/alt/`。**只有做权重对比实验时才需要**，正常跑分析不需要。
（实测结论：两组变体的 N 段反而更多，所以默认用的是仓库自带的 `reweight(0.0,10.0)`。）

### 3.3 Python 依赖

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install librosa soundfile soxr numpy onnx onnxruntime
```

`analyze_song.py` 里所有上游 import 都是**函数内延迟导入**，所以只要不调那条链路，
没装这些也不影响 Rust 侧开发。

### 3.4 跑一次 Python 分析（对照用）

```bash
MUSICANAZ_ANALYZER=python bun run tauri dev    # 强制走 Python 引擎
# 或直接跑脚本看 stdout 的 JSONL 进度
python neural/analyze_song.py "path/to/song.flac"
```

输出协议（stdout 一行一个 JSON）：`{"type":"progress",...}` / `{"type":"partial",...}` / `{"type":"result",...}`。
进度区间必须和 Rust 侧一致（probe 0–0.10 / tuning 0.10–0.14 / beats 0.14–0.46 / chords 0.46–0.87 /
structure 0.87–0.97），否则前端的阶段条在两条链路上表现会不一样。

### 3.5 验证「Rust 与 Python 一致」

```bash
python neural/verify_all.py        # 端到端对比
python neural/verify_chord_dicts.py
```

---

## 4. 重新导出 ONNX（改过模型/上游版本时才需要）

都在 `neural/` 下，输出直接写进 `client/src-tauri/assets/`：

| 脚本 | 产物 |
|---|---|
| `export_chord_folds.py` | `chord_fold0..4.onnx` |
| `export_chord_vocab.py` | `chord_vocab_*.tsv` + XHMM golden |
| `export_cqt_long_golden.py` | 长音频 CQT golden（查「音频变长后是否漂移」） |
| `export_structure_golden.py` | 结构分析 golden |

```bash
cd neural
python export_chord_folds.py
python export_chord_vocab.py
python export_cqt_long_golden.py
python export_structure_golden.py
```

导出完**一定要跑** `cargo test --lib`，golden 测试会告诉你 Rust 侧是否需要跟着改。

> 拍点模型 `beat_this_final.onnx` 由 `neural/export_*.py` 中 beat_this 那部分逻辑导出，
> 具体见脚本里的说明。

---

## 5. 上游有改动怎么办（当前：**零改动**）

四个仓库的 `git status` 里都没有已修改文件。**请保持这样。**

- ✅ 需要不同行为 → 在我们自己的代码里包一层（`neural/analyze_song.py`、`client/src-tauri/src/model/*`）
- ✅ 确实是上游 bug → 给上游提 PR
- ⚠️ 万不得已必须就地改 → 导出成 patch 放进 `neural/patches/`，并在下表的「本地改动」列登记

| 仓库 | 本地改动 |
|---|---|
| lv-chordia | 无 |
| beat_this | 无 |
| all-in-one-infer | 无 |
| demucs-infer | 无 |

导 patch 的方式：

```bash
git -C neural/beat_this diff > neural/patches/beat_this-<一句话说明>.patch
```

`setup-upstream.ps1` 会在 clone/checkout 后**自动尝试应用** `neural/patches/*.patch`（已应用则跳过）。

---

## 6. 打包发布

### 必须带 `custom-protocol` feature

`tauri.conf.json` 的 `frontendDist` 依赖 `custom-protocol` 这个 feature 才能生效。
**漏了它，连 `cargo build --release` 出来的 exe 也会去连 `http://localhost:1420`**，
双击后窗口里是 `ERR_CONNECTION_REFUSED`（开发服务器的地址，发布机上当然没有）。

```bash
# 开发：不启用 feature，走 vite dev server
bun run tauri dev

# 发布：必须显式带上
cd client/src-tauri
cargo build --release --features custom-protocol
```

> 注意 `Cargo.toml` 的 `[features]` 里要保留 `custom-protocol = ["tauri/custom-protocol"]`。
> 本项目早期精简依赖时删过一次，踩过这个坑。

### 为什么不用 `tauri build`

`tauri build` 在这台机器上会挂：rustc 报 `0xc0000142 STATUS_DLL_INIT_FAILED`
（LTO + `codegen-units=1` 下的进程初始化失败）。所以走 `cargo build` + 手工装配。

### 装配 zip

`.onnx` 和 `onnxruntime.dll` 都不入库，要手动放进 exe 同目录：

```
musicAnaz/
  musicAnaz.exe           前端 dist 已嵌入（6.7 MB）
  onnxruntime.dll         19 MB
  beat_this_final.onnx    80 MB
  chord_fold0..4.onnx     9.5 MB（5 个文件）
  chord_vocab_*.tsv       85 KB（3 个文件）
```

- `mel_fb.f32` 是 `include_bytes!` 编进二进制的，**不用**外置
- `golden_*.f32` 只给测试用，**不要打包**（白占 8 MB）
- 模型查找顺序：exe 同目录 → `exe/assets` → `MUSICANAZ_ASSETS_DIR` → 开发期 `CARGO_MANIFEST_DIR`

成品约 **91 MB**（解压 114 MB）。

### 验证发布包

冒烟测试只有一条：双击 exe，能开窗且不报 `ERR_CONNECTION_REFUSED`，
导入一首歌能分析出结果（启动日志应出现 `[analyzer] Rust 引擎（ONNX，自包含）`）。

---

## 7. 踩着过的坑

### WebView2 会锁住数据目录

强杀 exe 后 `%LOCALAPPDATA%\com.xmmpp.client\EBWebView` 仍被遗留的 `msedgewebview2.exe`
占用，再启动报 `0x800700AA 请求的资源在使用中`。清理时按命令行过滤，
**不要**杀全部 `msedgewebview2`（别的应用也在用）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
  Where-Object { $_.CommandLine -like '*com.xmmpp.client*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### dev 构建慢 20~50 倍

`[profile.dev]` 里的 `opt-level = 1` + 依赖包 `opt-level = 3` 不要删。
去掉之后 CQT/chroma 从 22s 变成 >60s，看起来像卡死。

---

## 8. 新开发者 checklist

- [ ] `bun install`，`bun run tauri dev` 能开窗
- [ ] `client/src-tauri/assets/` 里有 6 个 `.onnx`，启动日志出现 `Rust 引擎（ONNX，自包含）`
- [ ] `cargo test --lib` 92 passed
- [ ] `bun run test` 全绿
- [ ] （可选）`scripts/setup-upstream.ps1` 拉好上游，`verify_all.py` 与 Rust 结果一致
