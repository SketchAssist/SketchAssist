#!/usr/bin/env bash
# SketchAssist Python サイドカー — PyInstaller ビルドスクリプト（Linux / macOS）
# 出力: packages/python-sidecar/dist/sidecar/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "▶ Building Python sidecar with PyInstaller..."

pyinstaller \
  --onedir \
  --name sidecar \
  --distpath dist \
  --workpath build/pyinstaller \
  --specpath build \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import cv2 \
  runner.py

echo "✓ Sidecar built → dist/sidecar/"
