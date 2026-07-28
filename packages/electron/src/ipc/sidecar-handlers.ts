/**
 * Python サイドカー IPC ハンドラ
 *
 * renderer（React）がサイドカーの状態を取得・監視するための
 * IPC ブリッジ。サイドカーの起動・停止・ヘルスポーリングは
 * main.ts の SidecarManager が担当し、このファイルは状態の
 * 読み書きインターフェースだけを提供する。
 *
 * 登録される IPC チャンネル:
 *   get-sidecar-status  (invoke) → SidecarStatus
 *   sidecar-status-changed (on)  ← main → renderer イベント
 */

import { ipcMain, BrowserWindow } from "electron";

// ── 型定義 ────────────────────────────────────────────────────────

export type SidecarStatusCode = "starting" | "ready" | "error" | "unavailable";

export interface SidecarStatus {
  status: SidecarStatusCode;
  /** エラーや待機中のメッセージ */
  message?: string;
  /** サイドカーが起動している HTTP ポート（ready 時のみ） */
  port?: number;
}

// ── モジュール内共有状態 ──────────────────────────────────────────

let _current: SidecarStatus = { status: "starting" };

// ── 状態操作（main.ts の SidecarManager が呼び出す） ──────────────

/**
 * サイドカーの現在状態を更新し、全ウィンドウへイベントを送信する。
 */
export function setSidecarStatus(status: SidecarStatus): void {
  _current = status;
  broadcastSidecarStatus(status);
}

/**
 * 現在のサイドカー状態を取得する（同期）。
 */
export function getSidecarStatusSync(): SidecarStatus {
  return _current;
}

/**
 * 全ブラウザウィンドウへ sidecar-status-changed イベントを送信する。
 */
export function broadcastSidecarStatus(status: SidecarStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("sidecar-status-changed", status);
    }
  }
}

// ── IPC ハンドラ登録 ──────────────────────────────────────────────

export function registerSidecarIPCHandlers(): void {
  /** renderer から現在状態を問い合わせる */
  ipcMain.handle("get-sidecar-status", (): SidecarStatus => {
    return _current;
  });
}
