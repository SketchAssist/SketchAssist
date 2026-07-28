# SketchAssist Python サイドカー

Python 画像処理パイプラインを FastAPI HTTP サーバーとして提供する。
Node.js api-server から呼ばれ、結果を JSON で返す。

## ディレクトリ構成

```
packages/python-sidecar/
  runner.py               ← FastAPI サーバー（安定アダプター、通常変更不要）
  orchestrator.py         ← パイプライン統括クラス  ← 上書きで更新
  requirements.txt        ← Python 依存関係
  projects/               ← 実行時に自動生成（中間画像・JSON の保存先）
  core/
    __init__.py
    stage_pipeline.py     ← ステージノード・ツリー  ← 上書きで更新
    profile_loader.py     ← プロファイル読み込み    ← 上書きで更新
    io_utils.py           ← 画像 I/O ユーティリティ ← 上書きで更新
    profiles/             ← モード別パラメータ      ← yaml 追加・上書きで更新
      insect.yaml
      plant.yaml
      fossil.yaml
      artifact.yaml
      general.yaml
    processors/
      __init__.py
      feature_removal.py      ← 上書きで更新
      edge_extraction.py      ← 上書きで更新
      photometric_filters.py  ← 上書きで更新
      adaptive_edges.py       ← 上書きで更新
      line_graph.py           ← 上書きで更新
      region_extraction.py    ← 上書きで更新
```

## パイプライン ステージ

```
Stage 0: 原本画像 (original)
    ↓ run_full_pipeline()
Stage 1: 範囲選択 (stage1_selected)   ← 投げ縄ポリゴン指定オプション
    ↓
Stage 2: 特徴線強調 (feature_removed)  ← 陰影・テクスチャ・ハイライト除去
    ↓ advance_stage()  ※ここから先は advance_stage() を繰り返す
Stage 3: エッジ抽出 (edge_extracted)   ← multi-scale Canny + Sobel
    ↓
Stage 4: 線の整理 (lines_organized)    ← 骨格化・グラフ構築・ノイズ枝除去
    ↓
Stage 5: 閉領域抽出 (regions_extracted) ← face-tracing → SVG + JSON 出力
```

## セットアップ

```bash
cd packages/python-sidecar
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 起動

```bash
python runner.py                        # デフォルト: 127.0.0.1:8765
SIDECAR_PORT=9000 python runner.py      # ポート変更
PIPELINE_DATA_DIR=/tmp/sa python runner.py  # データ保存先変更
```

## パイプラインファイルの更新方法

1. 新しい Python ファイルを該当のパスに **上書き** する  
   例: `core/processors/edge_extraction.py` を最新版で置き換え
2. サイドカーを **再起動** する（`Ctrl+C` → `python runner.py`）
3. api-server・React アプリ側の変更は不要

モードを追加する場合は `core/profiles/<モード名>.yaml` を作成するだけでよい。

## HTTP エンドポイント

| Method | Path | 説明 |
|--------|------|------|
| GET | `/health` | 生存確認 |
| POST | `/pipeline/run` | Stage 0〜2 を実行（画像 base64 を受け取る） |
| POST | `/pipeline/advance` | 指定ノードから次 Stage へ 1 ステップ進む |
| POST | `/pipeline/advance-to-svg` | SVG 出力まで一括で進める |
| POST | `/pipeline/branch` | 指定ノードから別パラメータで分岐 |
| GET | `/pipeline/{project_id}/tree` | ステージツリー全体を取得 |
| GET | `/pipeline/{project_id}/node/{node_id}/image` | 中間画像を base64 PNG で取得 |
| GET | `/pipeline/{project_id}/node/{node_id}/extra/{key}` | SVG / JSON を取得 |

## 呼び出しフロー（システム全体）

```
[React Frontend]
      │  fetch /api/projects/:id/pipeline/*
      ▼
[Node.js api-server]  artifacts/api-server/src/routes/pipeline.ts
      │  fetch http://127.0.0.1:8765/pipeline/*
      ▼
[Python FastAPI]  packages/python-sidecar/runner.py
      │  import orchestrator.Orchestrator
      ▼
[Pipeline Modules]  orchestrator.py + core/*.py
```

## データ保存形式

各プロジェクトは `projects/proj_<DB_ID>/` に保存される:

```
projects/proj_42/
  project_manifest.json   ← StageTree のノード構造（JSON）
  nodes/
    <node_id>.png         ← 各ステージの中間画像
    <node_id>.svg         ← Stage5 SVG 出力
    <node_id>_faces.json  ← Stage5 面データ JSON
    <node_id>_graph.json  ← Stage4 グラフ JSON
```
