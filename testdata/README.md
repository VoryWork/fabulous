# testdata — 三首参考歌曲的分析结果

用来复现和回归分析链的样本。

> ⚠️ **音频不在仓库里**（`audio.flac` 已移除）：这些是商业歌曲，有版权，
> 不适合随源码分发。仓库只保留**分析结果**（`analysis.json` / `edits.json`），
> 它们是我们自己的产物，不含原始音频内容。

## 内容

| 目录 | 歌曲 | 时长 | 小节 |
|---|---|---|---|
| `01-manchite-yuku/` | 満ちてゆく — 藤井風 | 315.4s | 185 |
| `02-nannan-w/` | 何なんw (WTF lol) — 藤井风 | 320.0s | 120 |
| `03-tokuni-nai/` | 特にない (没什么特别) — 藤井风 | 205.3s | 85 |

每个目录：

```
analysis.json    模型输出（beat_this + lv-chordia + all-in-one-infer 的合成结果）
edits.json       用户编辑层（调性覆盖 / 级数轨 / 和弦编辑 / 结构编辑），可能不存在
meta.json        歌曲元信息 + 原始 song id
audio.flac       ❌ 不入库（版权），自己准备
```

三首恰好覆盖三种边界情况，这也是当初选它们的原因：

- **満ちてゆく**：录音比标准音高低 34.7 音分（必须移调校正），swing 节奏
  （长短拍比 2.31），所以 `meta.groove` 会返回「鼓组模式不明确」
- **何なんw**：开头 2.76s 是纯前奏（无鼓组），第一个 downbeat 就在 2.76s
- **特にない**：切分多，和弦边界抖动大

## 怎么用

### 只看数据 / 跑诊断脚本 → 直接读 json

```bash
# 小节网格诊断（需要 DB 里有这首歌，或用 --audio 指定）
python -u neural/check_grid.py <song_id>

# 鼓组相位体检（底鼓 1/3 拍、军鼓 2/4 拍）
python -u neural/check_energy.py <song_id>
python -u neural/check_groove.py <song_id>
```

### 自己准备音频（仓库不含）

音频是商业歌曲，**请通过自己的合法渠道获取**（购买的数字专辑 / 自己的 CD 抓轨等）。
仓库只提供分析结果给你做对照。

#### 需要哪三首

| 目录 | 曲名 | 艺术家 | **期望时长** |
|---|---|---|---|
| `01-manchite-yuku/` | 満ちてゆく | 藤井風 | `5:15.387`（315.387s） |
| `02-nannan-w/` | 何なんw (WTF lol) | 藤井风 | `5:19.973`（319.973s） |
| `03-tokuni-nai/` | 特にない (没什么特别) | 藤井风 | `3:25.258`（205.258s） |

#### 必须是同一个录音版本

这是最容易踩的坑。**现场版、重制版、不同母带的时长都对不上**：

```
満ちてゆく  专辑版    315.387s   ← analysis.json 是照这个算的
満ちてゆく  某个重制   314.8s     ← 差 0.6s，整首歌的拍点会整体错位
```

用错版本再去和 `analysis.json` 比，会得到一堆莫名其妙的差异，然后你会以为是代码改坏了。

#### 放哪里

```
testdata/songs/01-manchite-yuku/audio.flac
testdata/songs/02-nannan-w/audio.flac
testdata/songs/03-tokuni-nai/audio.flac
```

- 文件名必须是 `audio.flac`（或者改该目录 `meta.json` 里的 `audioFile` 字段）
- 格式：**推荐 flac 无损**。mp3/aac 也能解码，但编码本身有损，
  和 `analysis.json` 的数值对比时可能差一点点 —— 排查代码问题时别引入这个变量
- 采样率不限（44.1k / 48k 都行，分析链会重采样到 22050）

#### 放完自检

```bash
python neural/check_testdata.py
```

它检查两件事：**在不在**、**版本对不对**（比对 `meta.json` 的 `durationSec`，差 > 0.05s 报警）。

```
[OK] 01-manchite-yuku  5:15.387  44100 Hz  藤井風 — 満ちてゆく
[!!] 02-nannan-w  时长对不上（藤井风 — 何なんw (WTF lol)）
    期望 5:19.973 / 实测 5:18.100 / 差 +1.873s
    → 大概率是**另一个版本**（现场、重制、不同母带）。
[--] 03-tokuni-nai  缺音频（藤井风 — 特にない (没什么特别)）
    放到：testdata/songs/03-tokuni-nai/audio.flac
```

#### 只有一两首也行

需要音频的 Rust 测试都是 `#[ignore]` 的手动工具，**音频缺失时会打印提示后跳过**，不会失败：

```bash
cd client/src-tauri
cargo test --lib analysis::tests::dump_wave60 -- --ignored --nocapture
# → 跳过：找不到测试音频 …（testdata 音频因版权未入库，可用 MUSICANAZ_TEST_AUDIO 指定）
```

只有做「Rust 和 Python 结果是否逐值一致」这类对比（`rust_pipeline_matches_python`）时，
才必须用上面那三首原版；平时验证代码行为，随便给一首自己的歌就够：

```bash
MUSICANAZ_TEST_AUDIO="D:/music/任意一首.flac" \
  cargo test --lib analysis::tests::rust_pipeline_matches_python -- --ignored --nocapture
```

> 用别的歌跑这个测试时，期望值要一起换（`MUSICANAZ_TEST_EXPECT=<对应的 analysis.json>`），
> 否则就是拿 A 歌的结果去比 B 歌。

### 想在应用里打开

`analysis.json` 是我们自己的产物，可以直接导入看：

```
应用 → 左侧「+」→ 选 .fbsong 工程（analysis + edits 打包）
```

或走「导入音频 → 重新分析」的常规路径（音频自备）。

## 为什么只保留分析结果

分析链的行为高度依赖**真实的音高偏差、鼓组编配、切分方式**，合成信号测不出
（比如调音校正在 ±0 音分时根本不触发）。所以需要把同一批输入固定下来，
任何一次改动都能用同一份结果验证。

但**输入音频是别人的作品**。所以：分析结果入库（可回归、无版权问题），
音频不入库（需要的人自备）。如果将来要加更多样本，同样遵循这条。
