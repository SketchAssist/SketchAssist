/**
 * 同期 IPC ハンドラ
 * ipcMain.on（sendSync対応）で登録するシンプルなハンドラ群。
 */

import { ipcMain, app } from "electron";

export function registerSyncHandlers(): void {
  ipcMain.on("get-app-version", (event) => {
    event.returnValue = app.getVersion();
  });
}
