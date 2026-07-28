# ========================================================
# SketchAssist Python サイドカー ビルドスクリプト（Windows PowerShell）
# ========================================================
# 使い方:
#   cd packages\python-sidecar
#   .\build_sidecar.ps1           # 通常ビルド
#   .\build_sidecar.ps1 -Clean    # クリーンビルド
# ========================================================
param([switch]$Clean)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# ── クリーン ──────────────────────────────────────────────────────
if ($Clean) {
  Write-Host "🧹 クリーン中..."
  if (Test-Path "build") { Remove-Item -Recurse -Force "build" }
  if (Test-Path "dist")  { Remove-Item -Recurse -Force "dist"  }
}

# ── Python 確認 ────────────────────────────────────────────────────
$python = $null
foreach ($cmd in @("python", "python3", "py")) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) {
    $python = $cmd
    break
  }
}
if (-not $python) {
  Write-Error "❌ Python が見つかりません。Python 3.10 以上をインストールしてください。"
  exit 1
}
Write-Host "✅ Python: $(& $python --version)"

# ── 依存関係インストール ──────────────────────────────────────────
Write-Host ""
Write-Host "📦 依存関係をインストール中..."
& $python -m pip install --upgrade pip --quiet
& $python -m pip install -r requirements.txt --quiet
& $python -m pip install pyinstaller --quiet

# ── ビルド ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "🔨 PyInstaller でビルド中..."
& $python -m PyInstaller sidecar.spec --noconfirm --clean

# ── 確認 ──────────────────────────────────────────────────────────
$sidecarBin = "dist\sidecar\sidecar.exe"
if (Test-Path $sidecarBin) {
  $size = [math]::Round((Get-ChildItem -Recurse "dist\sidecar" | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
  Write-Host ""
  Write-Host "✅ ビルド成功: $scriptDir\$sidecarBin"
  Write-Host "   サイズ: ${size} MB"
  Write-Host ""
  Write-Host "📋 動作確認:"
  Write-Host "   Start-Process dist\sidecar\sidecar.exe"
  Write-Host "   Invoke-RestMethod http://127.0.0.1:8765/health"
} else {
  Write-Error "❌ ビルド失敗: $sidecarBin が見つかりません"
  exit 1
}
