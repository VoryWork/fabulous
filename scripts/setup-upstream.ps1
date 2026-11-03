#Requires -Version 5.1
<#
.SYNOPSIS
    拉取 / 更新 Python 链路的 4 个上游仓库到锁定 commit，并应用本地 patch。

.DESCRIPTION
    上游仓库**不入本仓库**（见 docs/dev-setup.md §3.1）：它们是第三方代码，
    体积 150MB+，我们一行都没改。这里用「锁定 commit + patch」替代 vendoring：

      1. 目录不存在 → git clone
      2. 已存在     → git fetch 后 checkout 到锁定 commit
      3. 应用 neural/patches/<repo>-*.patch（已应用的会跳过）

    脚本是幂等的，可以反复跑。

.PARAMETER SkipFetch
    跳过 git fetch（离线或已确认本地有该 commit 时用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/setup-upstream.ps1
#>
param(
    [switch]$SkipFetch
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# ── 版本锁 ───────────────────────────────────────────────────────────
# 改这里的 commit 之前先读 docs/dev-setup.md §3.2：换版本要重新验证
# （python neural/verify_all.py），因为权重行为可能跟着变。
$repos = @(
    @{
        Path   = 'neural/lv-chordia'
        Url    = 'https://github.com/openmirlab/lv-chordia.git'
        Commit = 'd8ab9ac'
        Note   = '和弦 5 折 ChordNet + XHMM（权重随仓库自带，83MB）'
    },
    @{
        Path   = 'neural/beat_this'
        Url    = 'https://github.com/CPJKU/beat_this.git'
        Commit = 'b95c8ab'
        Note   = '拍点 / 小节（权重首次运行自动下载）'
    },
    @{
        Path   = 'neural/all-in-one-infer'
        Url    = 'https://github.com/openmirlab/all-in-one-infer.git'
        Commit = '566f96c'
        Note   = '段落结构（权重首次运行自动下载）'
    },
    @{
        Path   = 'neural/demucs-infer'
        Url    = 'https://github.com/openmirlab/demucs-infer.git'
        Commit = 'a8552bb'
        Note   = '源分离（可选）'
    }
)

function Write-Step($msg) { Write-Host "  $msg" }
function Write-Head($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# ── 1. 拉取 ─────────────────────────────────────────────────────────
foreach ($r in $repos) {
    $dir = Join-Path $repoRoot $r.Path
    Write-Head "$($r.Path)  ($($r.Commit))"
    Write-Step $r.Note

    if (Test-Path (Join-Path $dir '.git')) {
        # 已 clone：确认没有本地修改，否则拒绝切 commit（防止把我们的 patch 覆盖掉）
        $dirty = & git -C $dir status --porcelain --untracked-files=no
        if ($dirty) {
            Write-Host "  ✗ 这个仓库有未提交的修改，先处理掉再跑本脚本：" -ForegroundColor Yellow
            $dirty | ForEach-Object { Write-Host "      $_" }
            Write-Host "    如果那是需要的改动，请导成 patch 放进 neural/patches/（见 docs/dev-setup.md §5）"
            continue
        }
        if (-not $SkipFetch) {
            Write-Step 'fetch…'
            & git -C $dir fetch --tags --quiet origin 2>&1 | Out-Null
        }
    } else {
        Write-Step 'clone…（首次会下载上百 MB）'
        & git clone --quiet $r.Url $dir 2>&1 | Out-Null
    }

    & git -C $dir checkout --quiet $r.Commit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ 找不到 commit $($r.Commit)（试过 -SkipFetch？去掉它重跑）" -ForegroundColor Red
        continue
    }
    $head = (& git -C $dir rev-parse --short HEAD 2>&1 | Select-Object -First 1)
    Write-Host "  ✓ 现在在 $head" -ForegroundColor Green
}

# ── 2. 应用本地 patch ────────────────────────────────────────────────
$patchDir = Join-Path $repoRoot 'neural/patches'
if (-not (Test-Path $patchDir)) { return }

$patches = Get-ChildItem -Path $patchDir -Filter '*.patch' -ErrorAction SilentlyContinue
if (-not $patches) { return }

Write-Head '应用本地 patch'
foreach ($p in $patches) {
    # 文件名约定：<repo 目录名>-<说明>.patch，例如 beat_this-fix-offset.patch
    $target = $repos | Where-Object { $p.Name.StartsWith((Split-Path $_.Path -Leaf) + '-') } | Select-Object -First 1
    if (-not $target) {
        Write-Host "  ? $($p.Name)：文件名没有对应仓库前缀，跳过" -ForegroundColor Yellow
        continue
    }
    $dir = Join-Path $repoRoot $target.Path

    # 先 --check：已应用 / 有冲突都能提前发现，不会把仓库改坏
    & git -C $dir apply --check --reverse $p.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  = $($p.Name)：已应用，跳过" -ForegroundColor DarkGray
        continue
    }
    & git -C $dir apply $p.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ $($p.Name)" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $($p.Name)：应用失败（上游可能变了，需要重新做 patch）" -ForegroundColor Red
    }
}

Write-Host "`n完成。下一步：docs/dev-setup.md §3.3 装 Python 依赖，§3.5 验证一致性。" -ForegroundColor Cyan
