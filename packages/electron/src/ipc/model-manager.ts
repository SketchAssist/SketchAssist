/**
 * モデル管理 IPC ハンドラ
 * - check-models: userData/models/ 内の各ファイル存在確認
 * - download-model: HTTP ストリームでダウンロード、進捗を renderer へ送信
 */

import { ipcMain, app, BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import { MODEL_REGISTRY, type ModelDefinition } from "../models";

// ダウンロードしたファイルの SHA-256 を計算する。
function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// userData/models/
function getModelsDir(): string {
  return path.join(app.getPath("userData"), "models");
}

function getModelPath(def: ModelDefinition): string {
  return path.join(getModelsDir(), def.filename);
}

// ── check-models ──────────────────────────────────────────────────
export function registerModelIPCHandlers(): void {
  ipcMain.handle("check-models", async () => {
    const modelsDir = getModelsDir();
    fs.mkdirSync(modelsDir, { recursive: true });

    return MODEL_REGISTRY.map((def) => {
      // Potrace はバンドル同梱扱い → 常に存在
      if (!def.downloadUrl) {
        return { id: def.id, exists: true };
      }
      const exists = fs.existsSync(getModelPath(def));
      return { id: def.id, exists };
    });
  });

  // ── download-model ──────────────────────────────────────────────
  ipcMain.handle("download-model", (event, modelId: string) => {
    return new Promise<void>((resolve, reject) => {
      const def = MODEL_REGISTRY.find((m) => m.id === modelId);
      if (!def) return reject(new Error(`Unknown model: ${modelId}`));
      if (!def.downloadUrl) return resolve(); // Potrace: スキップ

      const destPath = getModelPath(def);
      const tmpPath  = destPath + ".tmp";
      const modelsDir = getModelsDir();
      fs.mkdirSync(modelsDir, { recursive: true });

      // 送信先ウィンドウを event から取得
      const win = BrowserWindow.fromWebContents(event.sender);

      const sendProgress = (pct: number) => {
        try {
          win?.webContents.send("model-download-progress", { id: modelId, pct });
        } catch {
          // ウィンドウが既に閉じている場合は無視
        }
      };

      const doDownload = (url: string) => {
        const protocol = url.startsWith("https") ? https : http;
        const req = protocol.get(url, (res) => {
          // リダイレクト追跡
          if (res.statusCode === 301 || res.statusCode === 302) {
            const location = res.headers.location;
            if (location) { doDownload(location); return; }
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          }

          const total = parseInt(res.headers["content-length"] ?? "0", 10);
          let received = 0;
          const file = fs.createWriteStream(tmpPath);

          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0) {
              sendProgress(Math.round((received / total) * 100));
            }
          });

          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              // チェックサムが登録されているモデルは、renameSync(=正式採用)
              // 前に必ず検証する。未登録(null)の場合は検証をスキップするが、
              // これは経過措置であり、公開リリース前に models.ts 側で
              // 実際のハッシュ値を設定すべき(models.ts のコメント参照)。
              const verifyAndFinalize = async () => {
                try {
                  if (def.sha256) {
                    const actual = await computeSha256(tmpPath);
                    if (actual.toLowerCase() !== def.sha256.toLowerCase()) {
                      fs.unlink(tmpPath, () => {});
                      reject(new Error(
                        `モデル "${modelId}" のチェックサムが一致しません。` +
                        `ダウンロード元が改ざんされたか、ファイルが破損している可能性があります。` +
                        `(expected=${def.sha256}, actual=${actual})`
                      ));
                      return;
                    }
                  }
                  fs.renameSync(tmpPath, destPath);
                  sendProgress(100);
                  resolve();
                } catch (err) {
                  fs.unlink(tmpPath, () => {});
                  reject(err as Error);
                }
              };
              void verifyAndFinalize();
            });
          });
          file.on("error", (err) => {
            fs.unlink(tmpPath, () => {}); // tmp 削除
            reject(err);
          });
        });

        req.on("error", (err) => {
          fs.unlink(tmpPath, () => {});
          reject(err);
        });
      };

      doDownload(def.downloadUrl);
    });
  });
}
