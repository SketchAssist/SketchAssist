/**
 * 自動アップデート管理（スケルトン）
 *
 * 更新サーバーが設定されるまでは実際のチェックは行わない。
 * electron-builder.yml の publish.url が設定されたら
 * autoUpdater.checkForUpdatesAndNotify() を有効化する。
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  // 更新サーバー未設定のため、チェックはスキップ
  // TODO: 更新サーバー確定後に以下を有効化
  //
  // import { autoUpdater } from "electron-updater";
  //
  // autoUpdater.checkForUpdatesAndNotify();
  //
  // autoUpdater.on("update-available", () => {
  //   mainWindow.webContents.send("update-available");
  // });
  //
  // autoUpdater.on("update-downloaded", () => {
  //   mainWindow.webContents.send("update-downloaded");
  // });

  // renderer からの「今すぐ再起動してアップデート適用」リクエスト（将来用）
  ipcMain.on("restart-and-update", () => {
    // autoUpdater.quitAndInstall();
    void mainWindow; // 参照を維持（リンター対策）
  });
}
