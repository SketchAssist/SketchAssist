# SketchAssist Python サイドカー — PyInstaller ビルドスクリプト（Windows）
# 出力: packages/python-sidecar/dist/sidecar/
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "▶ Building Python sidecar with PyInstaller..."

pyinstaller `
  --onedir `
  --name sidecar `
  --distpath dist `
  --workpath build/pyinstaller `
  --specpath build `
  --hidden-import uvicorn.logging `
  --hidden-import uvicorn.loops `
  --hidden-import uvicorn.loops.auto `
  --hidden-import uvicorn.protocols `
  --hidden-import uvicorn.protocols.http `
  --hidden-import uvicorn.protocols.http.auto `
  --hidden-import uvicorn.protocols.websockets `
  --hidden-import uvicorn.protocols.websockets.auto `
  --hidden-import uvicorn.lifespan `
  --hidden-import uvicorn.lifespan.on `
  --hidden-import cv2 `
  runner.py

Write-Host "✓ Sidecar built → dist/sidecar/"
