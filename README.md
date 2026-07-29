# SketchAssist

学術論文・科学図版用の線画作成ツール。研究者が写真から説明図(輪郭線)を作成するための構造編集ソフトウェアです。

> 写真を忠実に模写するのではなく、研究対象の形態学的特徴を人間が理解しやすく表現することを目的とする。

**現在の実装状況**: 画像の読み込みから範囲指定(投げ縄選択)・影やテクスチャの除去・エッジ抽出まで(Stage0〜3)が実装済みです。抽出したエッジを1本の輪郭線としてつなげる「線の統合」や、閉じた領域の抽出は、現時点では未実装の今後の開発項目です(詳細は下記「パイプライン概要」参照)。手書き修正キャンバスの内容はSVGとして書き出せます。

---

## 特徴

- **AI 支援パイプライン** — 画像前処理・投げ縄による対象範囲指定・影やテクスチャの除去・エッジ抽出を段階的に実行(実装済み: Stage0〜3)
- **手書き修正** — パイプライン出力をベースにブラシ／消しゴムで直接編集し、その内容をSVGとして書き出し可能
- **被写体プロファイル** — 昆虫・植物・化石・遺物・汎用の 5 種類のパラメータセット
- **エクスポート** — SVGでの書き出しに対応。PDF/EPSは今後対応予定

---

## スタック

| 領域 | 技術 |
|---|---|
| フロントエンド | React 19 · Vite · TypeScript · Tailwind CSS |
| 画像処理 | Python 3.11 · FastAPI · OpenCV · scikit-image · SciPy |
| ランタイム | Node.js 24 · pnpm workspaces |

---

## オフライン動作について

SketchAssistは、標本や資料の画像を外部サーバーへ送信することはなく、画像処理はすべてローカルのPythonサイドカー上で完結します。

ただし、**初回起動時のみ**、AI支援機能(SAM2 / CLIP)のモデルファイルをHugging Faceからダウンロードするためにインターネット接続が必要です。一度モデルのダウンロードが完了すれば、それ以降はネットワーク接続なしで動作します。

---

## 必要環境

- **Node.js** 24 以上
- **pnpm** 10 以上
- **Python** 3.11 以上

---

## セットアップ

```bash
# 1. リポジトリをクローン
# ※ <YOUR_GITHUB_USERNAME_OR_ORG> は実際のGitHubユーザー名/Organization名に置き換えてください
git clone https://github.com/<YOUR_GITHUB_USERNAME_OR_ORG>/sketchassist.git
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
└── pipeline/                 # 画像処理パイプライン本体
    ├── orchestrator.py       # パイプライン実行管理
    └── core/
        ├── processors/       # 各処理モジュール
        └── profiles/         # 被写体別パラメータ（YAML）
```

---

## パイプライン概要

| ステージ | 処理内容 | 状態 |
|---|---|---|
| Stage 0 | 原本画像の読み込み | 実装済み |
| Stage 1 | 投げ縄選択（対象範囲の指定） | 実装済み |
| Stage 2 | 特徴線強調（影・テクスチャ・ハイライト除去） | 実装済み |
| Stage 3 | エッジ抽出 | 実装済み |
| Stage 4 | 線の整理（線の統合・接続・閉領域の下地作り） | 未実装（今後追加予定） |
| Stage 5 | 閉領域抽出・データ出力（ベクター化） | 未実装（今後追加予定） |

`orchestrator.py` のクラス冒頭の説明にも、実装済みの範囲(Stage0〜3)と、将来追加予定のStage4・Stage5への言及が併記されています。パイプラインの処理モジュール（`pipeline/core/`）は `runner.py` を再起動するだけで更新できます。

---

## ライセンス

[MIT](LICENSE)
