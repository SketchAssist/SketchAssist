# SketchAssist

学術論文・科学図版用の線画作成ツール。研究者が写真から SVG / PDF / EPS 形式の説明図を作成するための構造編集ソフトウェア。

> 写真を忠実に模写するのではなく、研究対象の形態学的特徴を人間が理解しやすく表現することを目的とする。

---

## 特徴

- **AI 支援パイプライン** — 画像前処理・背景除去・エッジ抽出・構造解析を段階的に実行
- **手書き修正** — パイプライン出力をベースにブラシ／消しゴムで直接編集
- **被写体プロファイル** — 昆虫・植物・化石・遺物・汎用の 5 種類のパラメータセット
- **ベクター出力** — SVG / PDF / EPS での書き出し対応

---

## スタック

| 領域 | 技術 |
|---|---|
| フロントエンド | React 19 · Vite · TypeScript · Tailwind CSS |
| 画像処理 | Python 3.11 · FastAPI · OpenCV · scikit-image · SciPy |
| ランタイム | Node.js 24 · pnpm workspaces |

---

## 必要環境

- **Node.js** 24 以上
- **pnpm** 10 以上
- **Python** 3.11 以上

---

## セットアップ

```bash
# 1. リポジトリをクローン
git clone https://github.com/<your-org>/sketchassist.git
cd sketchassist

# 2. Node.js 依存パッケージをインストール
#    ※ macOS / Windows で実行する場合は先に pnpm-workspace.yaml の
#      esbuild プラットフォーム除外行を削除してください（後述）
pnpm install

# 3. Python 依存パッケージをインストール
pip install -r packages/python-sidecar/requirements.txt
```

### macOS / Windows での追加手順

`pnpm-workspace.yaml` の `overrides` ブロックに含まれる esbuild のプラットフォーム除外行（`darwin-*` / `win32-*`）を削除してから `pnpm install` を実行してください。
これらの行は Replit（linux-x64）向けの最適化であり、他の環境では `pnpm install` が失敗します。

---

## 起動

```bash
# ターミナル 1 — Python サイドカー
cd packages/python-sidecar
python runner.py
# → http://127.0.0.1:8765

# ターミナル 2 — フロントエンド
pnpm --filter @workspace/sketchassist run dev
# → http://localhost:5173
```

### 環境変数（任意）

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `5173` | フロントエンドポート |
| `BASE_PATH` | `/` | フロントエンドのベースパス |
| `SIDECAR_PORT` | `8765` | Python サイドカーのポート |
| `SIDECAR_HOST` | `127.0.0.1` | Python サイドカーのホスト |
| `PIPELINE_DATA_DIR` | `packages/python-sidecar/projects/` | 処理結果の保存先 |

---

## プロジェクト構成

```
sketchassist/
├── artifacts/sketchassist/   # React フロントエンド
│   └── src/
│       ├── pages/            # ダッシュボード・エディター・書き出し
│       ├── components/       # UI コンポーネント
│       └── lib/              # パイプライン API クライアント
├── packages/python-sidecar/  # FastAPI サーバー（安定アダプター）
├── pipeline/                 # 画像処理パイプライン本体
│   ├── orchestrator.py       # パイプライン実行管理
│   └── core/
│       ├── processors/       # 各処理モジュール
│       └── profiles/         # 被写体別パラメータ（YAML）
└── docs/                     # 移行ガイド等
```

---

## パイプライン概要

| ステップ | 処理内容 |
|---|---|
| STEP 1 | 画像品質改善（影・反射・ノイズ除去） |
| STEP 2 | 対象抽出（背景分離） |
| STEP 3 | 意味的対象識別 |
| STEP 4 | 構造抽出（PolyLine 生成） |
| STEP 5 | Geometry 生成（StructureGraph 収束） |
| STEP 6 | 構造理解（AI 意味解釈） |
| STEP 7 | Ownership 推定 |
| STEP 8 | Geometry 検証 |
| STEP 9 | マスク生成 |
| STEP 10 | 構造編集（StructureGraph 編集） |
| STEP 11 | 図版生成（SVG / PDF / EPS） |

パイプラインの処理モジュール（`pipeline/core/`）は `runner.py` を再起動するだけで更新できます。

---

## ライセンス

[MIT](LICENSE)
