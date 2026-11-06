#!/usr/bin/env python
"""生成 THIRD-PARTY-NOTICES.md —— 第三方组件与模型权重的许可声明。

## 为什么需要这个文件

我们把别人的**模型权重**打进了发布包（beat_this 80MB、lv-chordia 5×1.9MB），
而且二进制里静态链接了几百个 Rust crate。MIT / MPL-2.0 / Unicode-3.0 这些许可
都要求「随分发保留版权与许可声明」，所以发布包必须带这份文件。

## 为什么要脚本生成

依赖会变。手写清单三个月后就跟 Cargo.lock 对不上了，然后没人知道该更新。
这个脚本从 `cargo metadata` 和 `node_modules` 现场读，重跑一次就是最新的。

## 用法

```bash
python scripts/gen-third-party.py          # 重写 THIRD-PARTY-NOTICES.md
python scripts/gen-third-party.py --check  # 只报告差异，不写文件（CI 用）
```

注意：脚本只覆盖「依赖清单」和「模型权重」两部分的内容来自这里；
文件开头的说明文字也在脚本里，改文案就改这里。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD-PARTY-NOTICES.md"

# ---------------------------------------------------------------- 模型权重
# 这些是真正被打进发布包的权重（client/src-tauri/assets/*.onnx）。
# all-in-one / demucs 只在 Python 对照链路用，**不随我们分发**，所以单独列。
MODELS = [
    {
        "name": "beat_this",
        "what": "拍点与小节检测（`beat_this_final.onnx`，80 MB）",
        "repo": "https://github.com/CPJKU/beat_this",
        "license": "MIT License",
        "copyright": "Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria",
        "license_file": "neural/beat_this/LICENSE",
        "note": (
            "上游 README 明确说明：代码与**发布的模型权重**都是 MIT，但"
            "「部分训练素材是完全版权作品或受限的 Creative Commons 授权，"
            "使用者需自行评估对本用途的影响」。我们把这条原样转达，"
            "不再做二次判断。"
        ),
    },
    {
        "name": "lv-chordia",
        "what": "和弦识别（`chord_fold0..4.onnx`，5 折 × 1.9 MB）",
        "repo": "https://github.com/openmirlab/lv-chordia",
        "license": "MIT License",
        "copyright": "Copyright (c) 2023 Music X Lab",
        "license_file": "neural/lv-chordia/LICENSE",
        "note": (
            "上游把 5 折权重直接 bundle 在仓库里（README 有专门章节说明这是"
            "「documented size-based exception」），所以随我们的包分发权重是符合其设计的。"
        ),
    },
]

# 只用于 Python 对照链路，权重在首次运行时由上游代码自己下载，不随我们分发
MODELS_NOT_SHIPPED = [
    {
        "name": "all-in-one-infer",
        "what": "段落结构（Python 对照链路；Rust 侧的结构分析是纯算法，不用这个模型）",
        "repo": "https://github.com/openmirlab/all-in-one-infer",
        "license": "MIT License（含来自 All-In-One / Demucs 的 MIT 代码）",
        "copyright": "Copyright (c) 2023 Taejun Kim; (c) 2025 Bo-Yu Chen",
        "note": "上游要求不随包分发权重（README: “No checkpoint is committed to git or shipped in a package”），我们遵守。",
    },
    {
        "name": "demucs-infer",
        "what": "源分离（可选，Python 链路）",
        "repo": "https://github.com/openmirlab/demucs-infer",
        "license": "MIT License",
        "copyright": "Copyright (c) Meta Platforms, Inc. and affiliates; (c) 2025 Bo-Yu Chen",
        "note": "权重首次运行时自动下载，不随我们分发。",
    },
]

# ------------------------------------------------------- MStruct 格式与官方编辑器
# 我们**不分发**它的代码或权重，但 client/src/export/mstruct.ts 是照抄官方序列化器
# 的实现（文件骨架、{TAG}value 元数据行、槽位时值合并规则），所以必须保留声明。
# 上游是分层许可：软件 MIT / 文档与示例分析 CC BY 4.0 / 名称与 Logo 不授权。
# 依据：LICENSE-SCOPE.md（master 分支）
MSTRUCT = {
    "repo": "https://github.com/Polymath9/mstruct-editor",
    "doi": "10.5281/zenodo.23637500",
    "code_copyright": "Copyright (c) 2026 MStruct Editor contributors",
    "doc_copyright": "Copyright © 2026 MStruct Editor contributors",
    "layers": [
        {
            "what": "软件源码，含 `src/core/mstruct-document.js` 的 `serializeMstructDocument()`",
            "use": "照抄实现（文件骨架、元数据行格式、槽位时值合并规则）",
            "license": "[MIT](https://github.com/Polymath9/mstruct-editor/blob/master/LICENSE)",
            "duty": "保留版权与许可声明",
        },
        {
            "what": "语法文档、技术手册、`examples/*.mstruct` 原创分析",
            "use": "参考语法规则与示例",
            "license": "[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)",
            "duty": "署名 MStruct Editor contributors，注明来源文件/版本，说明有修改",
        },
        {
            "what": "MStruct / MStruct Archive 的**名称、Logo、官方兼容标识**",
            "use": "**未使用**",
            "license": "❌ 不在任何开源授权内",
            "duty": "保留品牌权利",
        },
    ],
}

# ------------------------------------------------------------- 需要提示的许可
# 这些许可对分发方式有额外要求，单独说明，免得读者以为「都是 MIT」。
LICENSE_NOTES = [
    (
        "MPL-2.0",
        "文件级弱 copyleft。我们使用 crates.io 上的原版、未做修改，也没有把它们的代码"
        "混进我们自己的源文件，所以 MPL 只覆盖那些文件本身，不影响本项目的许可。"
        "按 MPL §3.2，分发二进制时应能指明对应源码位置 —— 下表给出了 crate 名与版本，"
        "源码都在 https://crates.io 上可查（同名同版本）。",
    ),
    (
        "Unicode-3.0",
        "Unicode 数据文件（icu_* 系列）的许可，允许随软件再分发，要求保留版权与许可声明"
        "（见下表所列包）。",
    ),
    (
        "Apache-2.0",
        "含专利授权条款；若某依赖同时给出 `MIT OR Apache-2.0`，我们按 MIT 履行义务。",
    ),
]


def rust_packages() -> list[dict]:
    """从 cargo metadata 取全部依赖（不含本仓库自己的 crate）。"""
    meta = json.loads(
        subprocess.run(
            ["cargo", "metadata", "--format-version", "1", "--manifest-path",
             str(ROOT / "client" / "src-tauri" / "Cargo.toml")],
            capture_output=True, text=True, check=True, encoding="utf-8",
        ).stdout
    )
    out = []
    for p in meta["packages"]:
        # 跳过本仓库自己的 crate（没有 license 字段，也不属于第三方）
        if p["name"] in {"client", "client_lib"}:
            continue
        out.append(
            {
                "name": p["name"],
                "version": p["version"],
                "license": p.get("license") or "(未在 Cargo.toml 中声明)",
                "repo": (p.get("repository") or "").strip(),
            }
        )
    return sorted(out, key=lambda x: x["name"].lower())


def npm_packages() -> list[dict]:
    """读取 node_modules 顶层包的 license 字段（前端直接 + 传递依赖）。"""
    nm = ROOT / "client" / "node_modules"
    if not nm.is_dir():
        return []
    out = []
    for entry in sorted(nm.iterdir()):
        if entry.name.startswith("."):
            continue
        candidates = [entry] if not entry.name.startswith("@") else [
            d for d in entry.iterdir() if d.is_dir()
        ]
        for c in candidates:
            pkg = c / "package.json"
            if not pkg.is_file():
                continue
            try:
                data = json.loads(pkg.read_text(encoding="utf-8"))
            except Exception:
                continue
            lic = data.get("license")
            if isinstance(lic, dict):
                lic = lic.get("type")
            out.append(
                {
                    "name": data.get("name", c.name),
                    "version": data.get("version", "?"),
                    "license": lic or "(未声明)",
                }
            )
    return sorted(out, key=lambda x: x["name"].lower())


def render(model_licenses: dict[str, str]) -> str:
    L = []
    L.append("# 第三方组件与模型权重的许可声明")
    L.append("")
    L.append("本项目（Fabulous）自身代码采用 [MIT 许可](LICENSE)。")
    L.append("")
    L.append(
        "> `LICENSE` 只覆盖本项目自身的源代码。发布包里分发的模型权重是**第三方作品**，"
        "各有自己的 MIT 许可与版权行，见下文 —— 两者不要混为一谈。"
    )
    L.append(
        "> （`LICENSE` 之所以只留标准 MIT 文本，是因为 GitHub 的许可识别器要求纯文本，"
        "加注释会被判成 NOASSERTION。）"
    )
    L.append("")
    L.append("下面是本项目使用、分发或链接的第三方作品。")
    L.append("")
    L.append("> 这份文件由 `scripts/gen-third-party.py` 生成，依赖变化后请重跑，不要手改。")
    L.append("")
    L.append("---")
    L.append("")

    # 1. 随包分发的模型权重
    L.append("## 1. 随发布包分发的模型权重")
    L.append("")
    L.append("发布包里的 `*.onnx` 是下列项目的权重经导出转换而来。**这两项是本项目分发的全部权重。**")
    L.append("")
    for m in MODELS:
        L.append(f"### {m['name']}")
        L.append("")
        L.append(f"- 用途：{m['what']}")
        L.append(f"- 来源：{m['repo']}")
        L.append(f"- 许可：{m['license']}")
        L.append(f"- {m['copyright']}")
        if m.get("note"):
            L.append(f"- 说明：{m['note']}")
        L.append("")
        body = model_licenses.get(m["license_file"], "")
        if body:
            L.append("```text")
            L.extend(body.rstrip().splitlines())
            L.append("```")
            L.append("")

    # 2. 不分发但依赖的上游
    L.append("## 2. Python 对照链路使用、但不随本项目分发的模型")
    L.append("")
    L.append("这些只在 `MUSICANAZ_ANALYZER=python` 的排查链路里用到，权重由上游代码在首次运行时自行下载。")
    L.append("")
    L.append("| 项目 | 用途 | 许可 |")
    L.append("|---|---|---|")
    for m in MODELS_NOT_SHIPPED:
        L.append(f"| [{m['name']}]({m['repo']}) | {m['what']} | {m['license']} |")
    L.append("")
    L.append("这些项目都是 MIT 许可（版权行见各自 LICENSE / NOTICE 文件）。")
    L.append("")
    # 3. MStruct 格式与官方编辑器（不随包分发，但是照抄了实现）
    L.append("## 3. MStruct 格式与官方编辑器")
    L.append("")
    L.append("`.mstruct` 导出格式（`client/src/export/mstruct.ts`）对齐 [MStruct Editor]"
             f"({MSTRUCT['repo']}) 的官方实现。上游是**分层许可**：")
    L.append("")
    L.append("| 上游内容 | 本项目怎么用 | 许可 | 义务 |")
    L.append("|---|---|---|---|")
    for row in MSTRUCT["layers"]:
        L.append(f"| {row['what']} | {row['use']} | {row['license']} | {row['duty']} |")
    L.append("")
    L.append(f"- 软件源码版权行：`{MSTRUCT['code_copyright']}`")
    L.append(f"- 文档与分析版权行：`{MSTRUCT['doc_copyright']}`（CC BY 4.0）")
    L.append("")
    L.append(f"> ⚠️ **名称与标识不在授权范围内。** 上游 `LICENSE-SCOPE.md` 明确：MIT 不覆盖"
             f"「MStruct、MStruct Archive 的名称、Logo 与官方兼容标识」，"
             f"且「随官方软件分发不代表授予独立品牌使用权」。"
             f"本项目只宣称「导出格式兼容 MStruct」，不宣称自己是官方产品、"
             f"不使用其 Logo，也不暗示得到官方背书。")
    L.append("")
    L.append(f"> 上游技术手册另以 DOI [{MSTRUCT['doi']}](https://doi.org/{MSTRUCT['doi']}) 发布，"
             f"引用该 DOI 不构成对其中内容的再分发。")
    L.append("")

    # 3. 许可注意事项
    L.append("## 4. 需要留意的许可条款")
    L.append("")
    for lic, note in LICENSE_NOTES:
        L.append(f"**{lic}** — {note}")
        L.append("")

    # 5. Rust 依赖
    rust = rust_packages()
    L.append(f"## 5. Rust 依赖（{len(rust)} 个 crate）")
    L.append("")
    L.append("| crate | 版本 | 许可 |")
    L.append("|---|---|---|")
    for p in rust:
        L.append(f"| {p['name']} | {p['version']} | {p['license']} |")
    L.append("")

    # 6. 前端依赖
    npm = npm_packages()
    if npm:
        L.append(f"## 6. 前端 (npm) 依赖（{len(npm)} 个包）")
        L.append("")
        L.append("| 包 | 版本 | 许可 |")
        L.append("|---|---|---|")
        for p in npm:
            L.append(f"| {p['name']} | {p['version']} | {p['license']} |")
        L.append("")

    # 7. 音频与测试数据
    L.append("## 7. 音频与测试数据")
    L.append("")
    L.append(
        "本仓库与发布包**都不包含任何音频文件**。`testdata/` 里只有我们自己跑出来的分析结果"
        "（`analysis.json` 等），不含原始录音。参考音频属于各自的版权方，需要使用者自备。"
    )
    L.append("")
    return "\n".join(L)


def main() -> int:
    # 读上游 LICENSE 全文（确保引用的就是原版文本，而不是我手抄的）
    model_licenses = {}
    for m in MODELS:
        p = ROOT / m["license_file"]
        if p.is_file():
            model_licenses[m["license_file"]] = p.read_text(encoding="utf-8", errors="replace")

    text = render(model_licenses)
    check = "--check" in sys.argv
    if check:
        old = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
        if old != text:
            print("THIRD-PARTY-NOTICES.md 已过期，请运行 python scripts/gen-third-party.py")
            return 1
        print("THIRD-PARTY-NOTICES.md 是最新的")
        return 0
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"written: {OUT.relative_to(ROOT)} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
