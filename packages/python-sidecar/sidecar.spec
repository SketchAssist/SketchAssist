# -*- mode: python ; coding: utf-8 -*-
"""
SketchAssist Python サイドカー PyInstaller ビルドスペック
==========================================================

ビルド方法:
    cd packages/python-sidecar
    pip install pyinstaller
    pyinstaller sidecar.spec

出力: dist/sidecar/   (--onedir)
  sidecar (or sidecar.exe)  ← 実行ファイル
  _internal/                ← ライブラリ・バイトコード
    pipeline/               ← パイプラインファイル（.py + .yaml）

electron-builder がこのディレクトリ全体を extraResources/sidecar/ に同梱する。
Electron の main.ts は初回起動時に pipeline/ を userData/pipeline/ へコピーし、
PIPELINE_FILES_DIR 環境変数でサイドカーに渡す（ユーザーが上書き可能）。
"""

block_cipher = None

# ── データファイル ────────────────────────────────────────────────
# pipeline/ ディレクトリ全体を bundle の pipeline/ に配置する。
# runner.py はデフォルトで _HERE/pipeline/ を探すので、
# onedir の _internal/ 直下に pipeline/ があれば正しく動作する。
added_datas = [
    # (src, dest_in_bundle)
    ('pipeline', 'pipeline'),
]

# ── 隠れた import ─────────────────────────────────────────────────
hidden_imports = [
    # uvicorn
    'uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto',
    'uvicorn.loops.asyncio', 'uvicorn.loops.uvloop',
    'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl', 'uvicorn.protocols.http.httptools_impl',
    'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.websockets_impl',
    'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.lifespan', 'uvicorn.lifespan.on', 'uvicorn.lifespan.off',
    # fastapi / pydantic
    'pydantic.v1', 'pydantic_core', 'anyio',
    'anyio._backends._asyncio', 'anyio._backends._trio',
    'starlette', 'starlette.middleware', 'starlette.middleware.cors',
    # scikit-image
    'skimage.filters', 'skimage.filters.edges', 'skimage.morphology',
    'skimage.measure', 'skimage.graph', 'skimage.draw', 'skimage.transform',
    'skimage.feature', 'skimage.segmentation', 'skimage._shared',
    'skimage.util', 'skimage.color', 'skimage.io',
    # scipy
    'scipy.ndimage', 'scipy.ndimage._filters', 'scipy.ndimage._interpolation',
    'scipy.sparse', 'scipy.sparse.csgraph', 'scipy.spatial', 'scipy.signal',
    # networkx
    'networkx', 'networkx.algorithms', 'networkx.algorithms.shortest_paths',
    'networkx.algorithms.components', 'networkx.drawing',
    # numpy / PIL / cv2
    'numpy', 'numpy.core._multiarray_umath',
    'PIL', 'PIL._imaging', 'PIL.Image',
    'cv2',
    # yaml
    'yaml', '_yaml',
]

a = Analysis(
    ['runner.py'],
    pathex=['.'],
    binaries=[],
    datas=added_datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'IPython', 'jupyter',
        'notebook', 'pytest', 'setuptools', 'pkg_resources',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe, a.binaries, a.zipfiles, a.datas,
    strip=False, upx=False, upx_exclude=[],
    name='sidecar',
)
