# 上游 patch

放**万不得已才做**的上游改动。

## 为什么是 patch 而不是直接改

`neural/{lv-chordia,beat_this,all-in-one-infer,demucs-infer}` 都是通过 `git clone` 拉取的第三方仓库，
**整个目录被 `.gitignore` 排除**，不进本仓库。所以你在那里改的东西：

- 只存在于你这一台机器上
- 别人 `git clone` 我们的仓库 + 跑 `setup-upstream.ps1` 之后拿不到
- 下次有人 `checkout` 到另一个 commit 就没了

当前四个仓库**零改动**（`git -C neural/<repo> status` 干净）。请尽量保持：

1. 想要不同行为 → 在我们自己的代码里包一层（`neural/analyze_song.py`、`client/src-tauri/src/model/*`）
2. 确实是上游 bug → 给上游提 PR
3. 真的必须就地改 → 导出成 patch 放这里

## 命名约定（脚本靠它找目标仓库）

```
<仓库目录名>-<一句话说明>.patch
```

| 文件名 | 应用到 |
|---|---|
| `beat_this-fix-chunk-offset.patch` | `neural/beat_this` |
| `lv-chordia-allow-cpu-decode.patch` | `neural/lv-chordia` |

## 导出与验证

```bash
# 1. 在改过的上游目录里导出
git -C neural/beat_this diff > neural/patches/beat_this-fix-chunk-offset.patch

# 2. 应用（setup 脚本会自动做，已应用的跳过）
powershell -ExecutionPolicy Bypass -File scripts/setup-upstream.ps1

# 3. 确认
git -C neural/beat_this status
```

`setup-upstream.ps1` 用 `git apply --check --reverse` 判断「是否已应用」：
能反向应用 = 已经打过了 → 跳过；否则正向应用，冲突则明确报错而不是把目录改坏。

## 顺带记一笔

改完上游之后记得重新跑 `python neural/verify_all.py` 和 `cargo test --lib`——
golden 数据是按上游某个固定版本生成的，上游一动结果就可能对不上。
