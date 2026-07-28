/**
 * Electron プリロードが window に注入する API の型定義。
 * Web ブラウザ環境では window.electronAPI は undefined。
 */

interface ElectronModelStatus { id: string; exists: boolean; }
interface ElectronDownloadProgress { id: string; pct: number; }

type ElectronSidecarStatusCode = "starting" | "ready" | "error" | "unavailable";
interface ElectronSidecarStatus {
  status: ElectronSidecarStatusCode;
  message?: string;
  /** ready 時のみ: サイドカーのポート番号 */
  port?: number;
}

interface ElectronAPI {
  readonly isElectron: true;
  getAppVersion(): string;

  // モデル管理
  checkModels(): Promise<ElectronModelStatus[]>;
  downloadModel(modelId: string): Promise<void>;
  onDownloadProgress(listener: (p: ElectronDownloadProgress) => void): () => void;

  // Python サイドカー状態
  getSidecarStatus(): Promise<ElectronSidecarStatus>;
  onSidecarStatusChange(listener: (s: ElectronSidecarStatus) => void): () => void;

  /**
   * パイプラインファイル更新後にサイドカーを再起動する。
   * pipeline-files ページの「サイドカー再起動」ボタンから呼ばれる。
   */
  restartSidecar(): Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
