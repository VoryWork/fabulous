# testdata — 三首参考歌曲

用来复现和回归分析链的样本。**音频在仓库里**，所以换一台机器不用先找歌。

## 内容

| 目录 | 歌曲 | 时长 | 小节 | 成品大小 |
|---|---|---|---|---|
| `01-manchite-yuku/` | 満ちてゆく — 藤井風 | 315.4s | 185 | 32 MB |
| `02-nannan-w/` | 何なんw (WTF lol) — 藤井风 | 320.0s | 120 | 37 MB |
| `03-tokuni-nai/` | 特にない (没什么特别) — 藤井风 | 205.3s | 85 | 43 MB |

每个目录：

```
audio.flac       原始音频（未做任何处理）
analysis.json    模型输出（beat_this + lv-chordia + all-in-one-infer 的合成结果）
edits.json       用户编辑层（调性覆盖 / 级数轨 / 和弦编辑 / 结构编辑），可能不存在
meta.json        歌曲元信息 + 原始 song id
```

三首恰好覆盖三种边界情况，这也是选它们的原因：

- **満ちてゆく**：录音比标准音高低 34.7 音分（必须移调校正），swing 节奏
  （长短拍比 2.31），所以 `meta.groove` 会返回「鼓组模式不明确」
- **何なんw**：开头 2.76s 是纯前奏（无鼓组），第一个 downbeat 就在 2.76s
- **特にない**：切分多，和弦边界抖动大

## 怎么用

### 只想看数据 / 跑脚本 → 直接读

`analysis.json` 就是完整的分析结果，`neural/` 下的诊断脚本可以直接吃它：

```bash
# 小节网格诊断（需要 DB 里有这首歌，或用 --audio 指定）
python -u neural/check_grid.py <song_id>

# 鼓组相位体检（底鼓 1/3 拍、军鼓 2/4 拍）
python -u neural/check_energy.py <song_id>
python -u neural/check_groove.py <song_id>
```

### 想在应用里打开 → 导入音频

```
应用 → 左侧「+」→ 选 testdata/songs/<目录>/audio.flac
```

会重新跑一遍分析（每首约 30 秒）。新生成的 song id 和 `meta.json` 里的
`originalId` **不一样**（id 是按音频指纹生成的，同一份音频会得到同一个 id，
但本地 DB 里没有记录时会新建）。

### 想省掉重新分析 → 手动塞进数据目录

`songs/<id>/` 的目录结构就是应用的数据布局（见 `db.rs::save_analysis`），
所以可以先建一条 song 记录，再把 `analysis.json` / `edits.json` 放进去：

```
%APPDATA%\com.xmmpp.client\
  musicanaz.db
  songs\
    <新 id>\
      analysis.json     ← 从 testdata 复制
      edits.json        ← 有则复制
```

注意 `analysis.json` 里的 `song.audioPath` 指向的是原机器的绝对路径
（`E:\音乐\...`）。路径不对时应用会走「音频失效 → 重新定位」流程，
把路径指到 `testdata/songs/<目录>/audio.flac` 即可。

## 为什么音频也进仓库

分析链的行为高度依赖**真实的音高偏差、鼓组编配、切分方式**，
合成信号测不出这些问题（比如调音校正在 ±0 音分时根本不触发）。
把这三首固定下来，任何一次改动都能用同一批输入验证，而不是
「换个音频结果就不一样，说不清是改坏了还是歌不同」。

代价是仓库大 113MB。如果以后要加更多样本，建议改用 Git LFS。
