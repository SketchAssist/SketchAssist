# @workspace/electron

SketchAssist の Electron デスクトップラッパーです。

## アーキテクチャ

```
packages/electron/
  src/
    main.ts               メインプロセス（BrowserWindow + api-server 子プロセス管理）
    preload.ts            プリロード（contextBridge で renderer へ API 公開）
    models.ts             モデルレジストリ（SAM2 / CLIP / Potrace の定義）
    ipc/
      model-manager.ts   モデルのダウンロード・存在確認 IPC ハンドラ
      sync-handlers.ts   同期 IPC ハンドラ（アプリバージョン取得等）

artifacts/sketchassist/src/
  electron.d.ts          window.electronAPI の型定義
  components/
    setup-wizard.tsx     Electron モード: 実ダウンロード / Web モード: シミュレーション
```

## 開発

Replit 上の開発は通常の Web アプリとして行う（Electron 起動は不要）。

ローカルマシンで Electron として起動する場合:

```bash
# 1. Vite dev server を起動（別ターミナル）
cd artifacts/sketchassist && pnpm dev

# 2. api-server を起動（別ターミナル）
cd artifacts/api-server && pnpm dev

# 3. Electron を起動
cd packages/electron
pnpm build          # TypeScript をコンパイル
VITE_DEV_SERVER_URL=http://localhost:5173 pnpm dev
```

## 配布ビルド（ローカルのみ）

`electron-builder` は Replit 環境にはインストールしない（パッケージファイアウォール制約）。
ローカルで配布ビルドを作る場合:

```bash
# ① React アプリをビルド
cd artifacts/sketchassist && pnpm build

# ② api-server をバンドル
cd artifacts/api-server && pnpm build

# ③ electron-builder をローカルのみ追加してビルド
cd packages/electron
pnpm add -D electron-builder --ignore-workspace-root-check
pnpm build
pnpm dist:win   # または dist:mac / dist:linux
```

## モデル管理

モデルは `app.getPath('userData')/models/` に保存される。

| ID           | ファイル名                    | 取得元                     |
| ------------ | ----------------------------- | -------------------------- |
| `sam2-tiny`  | `sam2_hiera_tiny.pt`          | HuggingFace facebook/sam2  |
| `clip-nano`  | `clip_vit_base_patch16.bin`   | HuggingFace openai/clip    |
| `potrace`    | `potrace`                     | アプリ同梱（DL 不要）       |

## 自動アップデート（electron-updater）

`electron-updater` は依存に含まれているが、更新サーバーの URL は未設定（`electron-builder.yml` の `publish.url` を参照）。
GitHub Releases を使う場合は `provider: github` + `owner`/`repo` を設定する。
