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

### 想跑需要音频的 Rust 测试

那些测试是 `#[ignore]` 的手动工具，音频缺失时会**打印提示后跳过**（不会失败）。
用环境变量指向你自己的歌：

```bash
cd client/src-tauri
MUSICANAZ_TEST_AUDIO="D:/music/your-song.flac" cargo test --lib \
  analysis::tests::dump_wave60 -- --ignored --nocapture
```

需要和这三首具体数值对比时（`rust_pipeline_matches_python`），
得自己准备同名歌并放到 `testdata/songs/<目录>/audio.flac`。

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
