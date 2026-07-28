#!/usr/bin/env bash
# ========================================================
# SketchAssist Python サイドカー ビルドスクリプト（Unix / macOS）
# ========================================================
# 使い方:
#   cd packages/python-sidecar
#   bash build_sidecar.sh           # 通常ビルド
#   bash build_sidecar.sh --clean   # クリーンビルド（build/ dist/ を削除してから実行）
# ========================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── オプション ─────────────────────────────────────────────────────
CLEAN=false
for arg in "$@"; do
  [[ "$arg" == "--clean" ]] && CLEAN=true
done

# ── クリーン ──────────────────────────────────────────────────────
if $CLEAN; then
  echo "🧹 クリーン中..."
  rm -rf build dist
fi

# ── Python 確認 ────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
  echo "❌ Python が見つかりません。Python 3.10 以上をインストールしてください。"
  exit 1
fi

PYTHON=$(command -v python3 || command -v python)
echo "✅ Python: $($PYTHON --version)"

# ── 依存関係インストール ──────────────────────────────────────────
echo ""
echo "📦 依存関係をインストール中..."
$PYTHON -m pip install --upgrade pip --quiet
$PYTHON -m pip install -r requirements.txt --quiet
$PYTHON -m pip install pyinstaller --quiet

# ── ビルド ────────────────────────────────────────────────────────
echo ""
echo "🔨 PyInstaller でビルド中..."
$PYTHON -m PyInstaller sidecar.spec \
  --noconfirm \
  --clean

# ── 確認 ──────────────────────────────────────────────────────────
SIDECAR_BIN="dist/sidecar/sidecar"
if [ -f "$SIDECAR_BIN" ]; then
  echo ""
  echo "✅ ビルド成功: $SCRIPT_DIR/$SIDECAR_BIN"
  echo "   サイズ: $(du -sh dist/sidecar | cut -f1)"
  echo ""
  echo "📋 動作確認:"
  echo "   dist/sidecar/sidecar &"
  echo "   curl http://127.0.0.1:8765/health"
else
  echo "❌ ビルド失敗: $SIDECAR_BIN が見つかりません"
  exit 1
fi
