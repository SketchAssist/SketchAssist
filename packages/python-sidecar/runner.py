#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SketchAssist Python サイドカー
================================
FastAPI HTTP サーバー。Node.js api-server から呼ばれ、
Python 画像処理パイプライン（pipeline/ ディレクトリ）を実行する。

このファイルは「安定したアダプター」として位置づけ、通常は変更しない。

────────────────────────────────────────────────────────────────────
パイプラインファイルの更新方法
────────────────────────────────────────────────────────────────────
pipeline/ フォルダ内のファイルを上書きするだけで更新できる。
runner.py 自体は変更不要。

  pipeline/
    orchestrator.py         ← メインオーケストレーター
    core/
      stage_pipeline.py     ← ステージノード・ツリー
      profile_loader.py     ← プロファイル読み込み
      io_utils.py           ← 画像 I/O
      processors/           ← 各ステージ処理モジュール
        feature_removal.py
        edge_extraction.py
        ...
      profiles/             ← 被写体別パラメータ（yaml）
        insect.yaml
        plant.yaml
        ...

────────────────────────────────────────────────────────────────────
環境変数
────────────────────────────────────────────────────────────────────
  SIDECAR_PORT         サーバーポート (default: 8765)
  SIDECAR_HOST         サーバーホスト (default: 127.0.0.1)
  PIPELINE_FILES_DIR   pipeline/ ファイルの読み込み元ディレクトリ
                       未設定時は <runner.pyと同じ階層>/pipeline/
  PIPELINE_DATA_DIR    処理結果の保存先 (default: <runner.py階層>/projects/)
────────────────────────────────────────────────────────────────────
"""

import base64
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

# ── パス解決 ────────────────────────────────────────────────────────
# PyInstaller frozen binary では sys._MEIPASS がバンドル展開先になる。
# 通常実行では __file__ の親ディレクトリを使う。
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    _HERE = Path(sys._MEIPASS)  # type: ignore[attr-defined]
else:
    _HERE = Path(__file__).parent.resolve()

# pipeline/ ディレクトリの解決:
#   1. PIPELINE_FILES_DIR 環境変数（Electron prod: userData/pipeline/）
#   2. frozen binary: _HERE/pipeline/ （PyInstaller バンドル内）
#   3. 通常実行: runner.py の 2 階層上（workspace root）/ pipeline/
#      packages/python-sidecar/runner.py → parent = packages/python-sidecar/
#                                        → parent.parent = workspace root
_env_pipeline_dir = os.environ.get("PIPELINE_FILES_DIR", "").strip()
if _env_pipeline_dir:
    _PIPELINE_DIR = Path(_env_pipeline_dir).resolve()
elif getattr(sys, "frozen", False):
    _PIPELINE_DIR = _HERE / "pipeline"
else:
    _PIPELINE_DIR = _HERE.parent.parent / "pipeline"

# pipeline/ を sys.path の先頭に追加
# → `from orchestrator import Orchestrator` と `from core.xxx import ...` が解決できる
if str(_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_DIR))

# ── パイプライン本体 import ────────────────────────────────────────
import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from orchestrator import Orchestrator  # type: ignore[import]

# ── バージョン ─────────────────────────────────────────────────────
# アプリ全体(ルート/electron/フロントエンド)の package.json と揃えること。
# ここでの二重定義(FastAPIのversion=とhealthエンドポイントの両方)を避けるため、
# この定数1箇所だけを更新すればよいようにしている。
__version__ = "1.0.0"

# ── アプリ設定 ─────────────────────────────────────────────────────
app = FastAPI(
    title="SketchAssist Pipeline Sidecar",
    version=__version__,
    description="Python 画像処理パイプラインへの HTTP インターフェース",
)

# サイドカーはローカルホスト上でのみ待ち受ける前提のため、CORSも
# localhost/127.0.0.1 (任意ポート)に限定する。"*" は指定しない
# ("*" を含めると個別オリジンの列挙が無意味になり、意図が不明瞭になるため)。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(os.environ.get("PIPELINE_DATA_DIR", _HERE / "projects"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

_orchestrators: dict[str, Orchestrator] = {}


# ── ヘルパー ──────────────────────────────────────────────────────

def get_orchestrator(project_id: str) -> Orchestrator:
    if project_id not in _orchestrators:
        project_dir = DATA_DIR / project_id
        project_dir.mkdir(parents=True, exist_ok=True)
        _orchestrators[project_id] = Orchestrator(str(project_dir))
    return _orchestrators[project_id]


def image_to_b64(img: np.ndarray) -> str:
    success, buf = cv2.imencode(".png", img)
    if not success:
        raise ValueError("画像の PNG エンコードに失敗しました")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def b64_to_temp_file(b64_data: str) -> str:
    raw = base64.b64decode(b64_data)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    tmp.write(raw)
    tmp.close()
    return tmp.name


def polys_to_tuples(polys: Optional[list[list[list[int]]]]) -> Optional[list[list[tuple[int, int]]]]:
    if not polys:
        return None
    return [[(p[0], p[1]) for p in poly] for poly in polys]


# ── リクエスト / レスポンス モデル ───────────────────────────────

class RunPipelineRequest(BaseModel):
    project_id: str
    image_b64: str
    mode: str = "general"
    include_polygons: Optional[list[list[list[int]]]] = None
    exclude_polygons: Optional[list[list[list[int]]]] = None


class AdvanceStageRequest(BaseModel):
    project_id: str
    node_id: str
    mode: str = "general"
    include_polygons: Optional[list[list[list[int]]]] = None
    exclude_polygons: Optional[list[list[list[int]]]] = None


class BranchStageRequest(BaseModel):
    project_id: str
    parent_id: str
    stage_type: str
    params: dict = {}
    label: str = "分岐ノード"


# ── エンドポイント ─────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": __version__,
        "pipeline_dir": str(_PIPELINE_DIR),
    }


@app.post("/pipeline/run")
def run_pipeline(req: RunPipelineRequest):
    tmp_path = None
    try:
        orc = get_orchestrator(req.project_id)
        tmp_path = b64_to_temp_file(req.image_b64)
        result = orc.run_full_pipeline(
            tmp_path, req.mode,
            stage1_include_polygons=polys_to_tuples(req.include_polygons),
            stage1_exclude_polygons=polys_to_tuples(req.exclude_polygons),
        )
        return {"ok": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if tmp_path:
            try: os.unlink(tmp_path)
            except OSError: pass


@app.post("/pipeline/advance")
def advance_stage(req: AdvanceStageRequest):
    try:
        orc = get_orchestrator(req.project_id)
        result = orc.advance_stage(
            req.node_id, req.mode,
            stage1_include_polygons=polys_to_tuples(req.include_polygons),
            stage1_exclude_polygons=polys_to_tuples(req.exclude_polygons),
        )
        return {"ok": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/pipeline/branch")
def branch_stage(req: BranchStageRequest):
    try:
        orc = get_orchestrator(req.project_id)
        result = orc.branch_from_stage(req.parent_id, req.stage_type, req.params, req.label)
        return {"ok": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pipeline/{project_id}/tree")
def get_tree(project_id: str):
    try:
        orc = get_orchestrator(project_id)
        nodes = {nid: n.to_dict() for nid, n in orc.tree.nodes.items()}
        return {"ok": True, "root_id": orc.tree.root_id, "nodes": nodes}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pipeline/{project_id}/node/{node_id}/image")
def get_node_image(project_id: str, node_id: str):
    try:
        orc = get_orchestrator(project_id)
        img = orc.tree.load_image(node_id)
        return {"ok": True, "image_b64": image_to_b64(img), "format": "png"}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pipeline/{project_id}/node/{node_id}/extra/{key}")
def get_node_extra(project_id: str, node_id: str, key: str):
    try:
        orc = get_orchestrator(project_id)
        content = orc.tree.load_extra_file(node_id, key)
        return {"ok": True, "content": content, "key": key}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── エントリーポイント ────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", 8765))
    host = os.environ.get("SIDECAR_HOST", "127.0.0.1")
    print(f"SketchAssist サイドカー起動: http://{host}:{port}")
    print(f"  pipeline dir : {_PIPELINE_DIR}")
    print(f"  data dir     : {DATA_DIR}")
    uvicorn.run(app, host=host, port=port, log_level="info")
