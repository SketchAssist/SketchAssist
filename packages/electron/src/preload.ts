/**
 * Electron プリロードスクリプト
 *
 * contextBridge を通じて renderer（React）へ安全な API を公開する。
 *
 * 公開する API:
 *   window.electronAPI.isElectron              — Electron 環境判定フラグ
 *   window.electronAPI.getAppVersion()         — アプリバージョン文字列
 *   window.electronAPI.checkModels()           — モデルファイルの存在確認
 *   window.electronAPI.downloadModel()         — モデルのダウンロード
 *   window.electronAPI.onDownloadProgress()    — 進捗イベントのリスナー登録
 *   window.electronAPI.getSidecarStatus()      — Python サイドカーの現在状態
 *   window.electronAPI.onSidecarStatusChange() — サイドカー状態変化のリスナー登録
 *   window.electronAPI.restartSidecar()        — パイプラインファイル更新後に再起動
 */

import { contextBridge, ipcRenderer } from "electron";
import { exposeSidecarPortBridge } from "./sidecar-port-bridge";

// ── 型定義 ────────────────────────────────────────────────────────

interface ModelStatus { id: string; exists: boolean; }
interface DownloadProgressPayload { id: string; pct: number; }
type SidecarStatusCode = "starting" | "ready" | "error" | "unavailable";
interface SidecarStatus { status: SidecarStatusCode; message?: string; port?: number; }

// ── API 実装 ─────────────────────────────────────────────────────

const electronAPI = {
  isElectron: true as const,

  getAppVersion: (): string =>
    ipcRenderer.sendSync("get-app-version") as string,

  checkModels: (): Promise<ModelStatus[]> =>
    ipcRenderer.invoke("check-models"),

  downloadModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke("download-model", modelId),

  onDownloadProgress: (listener: (p: DownloadProgressPayload) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, p: DownloadProgressPayload) => listener(p);
    ipcRenderer.on("model-download-progress", h);
    return () => ipcRenderer.removeListener("model-download-progress", h);
  },

  getSidecarStatus: (): Promise<SidecarStatus> =>
    ipcRenderer.invoke("get-sidecar-status"),

  onSidecarStatusChange: (listener: (s: SidecarStatus) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, s: SidecarStatus) => listener(s);
    ipcRenderer.on("sidecar-status-changed", h);
    return () => ipcRenderer.removeListener("sidecar-status-changed", h);
  },

  /**
   * パイプラインファイルを更新した後にサイドカーを再起動する。
   * 戻り値: { ok: boolean }
   */
  restartSidecar: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("restart-sidecar"),
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
exposeSidecarPortBridge();
