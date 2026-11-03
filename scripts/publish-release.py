#!/usr/bin/env python
"""把 dist 发布到 GitHub Releases（创建 release + 上传 zip）。

## 为什么需要 token

推送代码用 SSH key 就够了，但**创建 Release 和上传附件只能走 GitHub API**，
SSH key 不能用于 API 认证。所以这里需要一个有 `repo` 权限的 personal access token。

生成方式（二选一）：
  https://github.com/settings/tokens          classic，勾 `repo`
  https://github.com/settings/tokens?type=beta fine-grained，给本仓库 Contents: Read and write

## 用法

```bash
GH_TOKEN=ghp_xxx python scripts/publish-release.py
```

可选参数：

```bash
python scripts/publish-release.py --tag v0.1.0 \
  --notes docs/releases/v0.1.0.md \
  --asset dist-zip/Fabulous-0.1.0-win64.zip \
  --draft          # 先发草稿，网页上确认后再点 publish
```

脚本是幂等的：release 已存在就复用，同名附件已存在就删掉重传
（所以重跑不会产生第二个 zip，也不会报 422）。

注意输出只用 ASCII 标记：中文 Windows 控制台是 GBK，打印 ✓ 会 UnicodeEncodeError。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "VoryWork/fabulous"
API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"


def token() -> str:
    t = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not t:
        print("[!!] 缺少 GH_TOKEN（需要 repo 权限的 personal access token）")
        print("     生成: https://github.com/settings/tokens")
        sys.exit(2)
    return t.strip()


def call(method: str, url: str, tok: str, payload=None, raw: bytes | None = None,
         ctype: str | None = None, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {tok}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "fabulous-release-script")
    if raw is not None:
        req.data = raw
        if ctype:
            req.add_header("Content-Type", ctype)
        req.add_header("Content-Length", str(len(raw)))
    elif payload is not None:
        req.data = json.dumps(payload).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8") or "{}"
            return json.loads(body) if body.strip().startswith(("{", "[")) else {"raw": body}
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")[:500]
        raise SystemExit(f"[!!] HTTP {e.code} on {method} {url}\n{msg}") from None


def get_release(tag: str, tok: str) -> dict | None:
    try:
        return call("GET", f"{API}/repos/{REPO}/releases/tags/{tag}", tok)
    except SystemExit:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="v0.1.0")
    ap.add_argument("--name", default="v0.1.0 — 首个可分发版本")
    ap.add_argument("--notes", default="docs/releases/v0.1.0.md")
    ap.add_argument("--asset", default="dist-zip/Fabulous-0.1.0-win64.zip")
    ap.add_argument("--draft", action="store_true", help="发草稿，不直接公开")
    args = ap.parse_args()

    tok = token()
    notes_path = ROOT / args.notes
    asset_path = ROOT / args.asset
    if not notes_path.is_file():
        raise SystemExit(f"[!!] 找不到 {notes_path}")
    if not asset_path.is_file():
        raise SystemExit(f"[!!] 找不到 {asset_path}（先打包）")

    body = notes_path.read_text(encoding="utf-8")
    size = asset_path.stat().st_size
    print(f"[..] 仓库   {REPO}")
    print(f"[..] tag    {args.tag}")
    print(f"[..] 附件   {asset_path.name} ({size / 1048576:.1f} MB)")

    rel = get_release(args.tag, tok)
    if rel:
        print(f"[OK] release 已存在，复用 (id={rel['id']})")
    else:
        rel = call("POST", f"{API}/repos/{REPO}/releases", tok, {
            "tag_name": args.tag,
            "name": args.name,
            "body": body,
            "draft": bool(args.draft),
            "prerelease": False,
        })
        print(f"[OK] release 已创建 (id={rel['id']})  {rel.get('html_url')}")

    # 同名附件先删再传（避免 422 already_exists，重跑时也不会留下两份）
    assets = call("GET", f"{API}/repos/{REPO}/releases/{rel['id']}/assets", tok)
    for a in assets if isinstance(assets, list) else []:
        if a.get("name") == asset_path.name:
            call("DELETE", f"{API}/repos/{REPO}/releases/assets/{a['id']}", tok)
            print(f"[--] 删掉旧附件 {a['name']}")

    print("[..] 上传中（91MB 走网络，可能几分钟）...")
    data = asset_path.read_bytes()
    up = call(
        "POST",
        f"{UPLOADS}/repos/{REPO}/releases/{rel['id']}/assets?name={asset_path.name}",
        tok,
        raw=data,
        ctype="application/zip",
        timeout=1800,
    )
    print(f"[OK] 上传完成 {(up.get('size') or 0) / 1048576:.1f} MB")
    print(f"[OK] {rel.get('html_url')}")
    if args.draft:
        print("[--] 当前是草稿，去网页点 Publish release 才会公开")
    return 0


if __name__ == "__main__":
    sys.exit(main())
