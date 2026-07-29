/**
 * Electron メインプロセス
 *
 * 起動順:
 *  1. pipelineDir 初期化（userData/pipeline/ を初回起動時にセットアップ）
 *  2. Python サイドカーを起動（dev: python runner.py / prod: PyInstaller binary）
 *  3. /health をポーリングしてサイドカーの準備完了を待つ
 *  4. api-server を起動（SIDECAR_URL・PIPELINE_FILES_DIR を注入）
 *  5. BrowserWindow を作成
 */

import { app, BrowserWindow, shell, ipcMain } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as child_process from "child_process";
import * as http from "http";
import * as net from "net";
import { registerModelIPCHandlers } from "./ipc/model-manager";
import { registerSyncHandlers } from "./ipc/sync-handlers";
import { registerSidecarPortIPC } from "./sidecar-port-bridge";
import {
  registerSidecarIPCHandlers,
  setSidecarStatus,
} from "./ipc/sidecar-handlers";

// ── 定数 ─────────────────────────────────────────────────────────
const isDev = !app.isPackaged;
const API_PORT = 3742;
const SIDECAR_PORT_BASE = 8765;

// ── 子プロセス ────────────────────────────────────────────────────
let apiServer: child_process.ChildProcess | null = null;
let sidecarProcess: child_process.ChildProcess | null = null;
let sidecarPort = SIDECAR_PORT_BASE;
let pipelineDir = ""; // userData/pipeline/ の絶対パス

// ═══════════════════════════════════════════════════════════════════
// ユーティリティ
// ═══════════════════════════════════════════════════════════════════

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(base: number, tries = 10): Promise<number> {
  for (let i = 0; i < tries; i++) {
    if (!(await isPortInUse(base + i))) return base + i;
  }
  return base;
}

function httpGet(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitForSidecar(
  port: number,
  timeoutMs = 60_000,
  pollingIntervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpGet(`http://127.0.0.1:${port}/health`)) return true;
    await new Promise((r) => setTimeout(r, pollingIntervalMs));
  }
  return false;
}

/** ディレクトリを再帰的にコピーする */
function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// パイプラインディレクトリ初期化
// ═══════════════════════════════════════════════════════════════════

/**
 * userData/pipeline/ を初期化する。
 *
 * - 初回起動時: ソースから pipeline/ をコピー
 *   - dev: <repo root>/pipeline/
 *   - prod: extraResources/pipeline-defaults/
 * - 2 回目以降: 既存の userData/pipeline/ をそのまま使う
 *
 * @returns userData/pipeline/ の絶対パス
 */
async function initPipelineDir(): Promise<string> {
  const userPipelineDir = path.join(app.getPath("userData"), "pipeline");

  if (!fs.existsSync(userPipelineDir)) {
    // ── ソースを決定 ──────────────────────────────────────────────
    const src = isDev
      ? path.resolve(__dirname, "../../../pipeline")
      : path.join(process.resourcesPath, "pipeline-defaults");

    console.log(`[pipeline-dir] 初回セットアップ: ${src} → ${userPipelineDir}`);
    try {
      copyDirSync(src, userPipelineDir);
    } catch (err) {
      console.error("[pipeline-dir] コピー失敗:", err);
    }
  } else {
    console.log(`[pipeline-dir] 既存を使用: ${userPipelineDir}`);
  }

  return userPipelineDir;
}

// ═══════════════════════════════════════════════════════════════════
// Python サイドカー
// ═══════════════════════════════════════════════════════════════════

async function startSidecar(): Promise<void> {
  sidecarPort = await findFreePort(SIDECAR_PORT_BASE);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIDECAR_PORT: String(sidecarPort),
    PIPELINE_FILES_DIR: pipelineDir,
    PIPELINE_DATA_DIR: path.join(app.getPath("userData"), "pipeline-projects"),
  };

  if (isDev) {
    const sidecarDir = path.resolve(__dirname, "../../../packages/python-sidecar");
    const python = process.platform === "win32" ? "python" : "python3";
    console.log(`[sidecar] dev: ${python} runner.py (port ${sidecarPort})`);
    sidecarProcess = child_process.spawn(python, ["runner.py"], {
      cwd: sidecarDir, env, stdio: "pipe",
    });
  } else {
    const exeName = process.platform === "win32" ? "sidecar.exe" : "sidecar";
    const sidecarBin = path.join(process.resourcesPath, "sidecar", exeName);
    console.log(`[sidecar] prod: ${sidecarBin} (port ${sidecarPort})`);
    sidecarProcess = child_process.spawn(sidecarBin, [], { env, stdio: "pipe" });
  }

  sidecarProcess.stdout?.on("data", (d: Buffer) => {
    if (isDev) process.stdout.write(`[sidecar] ${d}`);
  });
  sidecarProcess.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`[sidecar:err] ${d}`);
  });
  sidecarProcess.on("error", (err) => {
    console.error("[sidecar] Failed to start:", err.message);
    setSidecarStatus({ status: "error", message: err.message });
  });
  sidecarProcess.on("exit", (code, signal) => {
    if (code !== 0 && code !== null && signal !== "SIGTERM") {
      console.error(`[sidecar] Exited unexpectedly (code=${code})`);
      setSidecarStatus({ status: "error", message: `サイドカーが予期せず終了 (code=${code})` });
    }
  });
}

function stopSidecar(): void {
  if (sidecarProcess && !sidecarProcess.killed) {
    sidecarProcess.kill("SIGTERM");
    sidecarProcess = null;
  }
}

/**
 * サイドカーを停止して再起動する（ファイル更新後に呼ばれる）。
 */
async function restartSidecar(): Promise<void> {
  console.log("[sidecar] 再起動中...");
  setSidecarStatus({ status: "starting", message: "再起動中..." });
  stopSidecar();
  await new Promise(r => setTimeout(r, 500)); // 終了を待つ
  await startSidecar();
  const ready = await waitForSidecar(sidecarPort, 30_000);
  if (ready) {
    setSidecarStatus({ status: "ready", port: sidecarPort });
    console.log("[sidecar] 再起動完了");
  } else {
    setSidecarStatus({ status: "error", message: "再起動タイムアウト" });
  }
}

// ═══════════════════════════════════════════════════════════════════
// api-server
// ═══════════════════════════════════════════════════════════════════

function startApiServer(): void {
  const serverEntry = isDev
    ? path.resolve(__dirname, "../../../artifacts/api-server/dist/index.mjs")
    : path.join(process.resourcesPath, "api-server", "index.mjs");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(API_PORT),
    NODE_ENV: isDev ? "development" : "production",
    SIDECAR_URL: `http://127.0.0.1:${sidecarPort}`,
    PIPELINE_FILES_DIR: pipelineDir,
    DATABASE_URL: isDev
      ? process.env.DATABASE_URL ?? ""
      : `file:${path.join(app.getPath("userData"), "sketchassist.db")}`,
  };

  apiServer = child_process.spawn("node", [serverEntry], {
    env, stdio: isDev ? "inherit" : "pipe",
  });

  // api-server からの restart-sidecar メッセージを受信
  if (apiServer.stdout) {
    // IPC over stdio（fork ではなく spawn なので stdout を使う）
    // api-server が process.send するとここでは受け取れない。
    // 代わりに IPC チャンネルを使う（後述）。
  }

  apiServer.on("error", (err) => console.error("[api-server] Failed:", err.message));
  apiServer.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[api-server] Exited (code=${code})`);
  });
}

function stopApiServer(): void {
  if (apiServer && !apiServer.killed) {
    apiServer.kill("SIGTERM");
    apiServer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// BrowserWindow
// ═══════════════════════════════════════════════════════════════════

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0a0a0a",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !isDev,
    },
  });

  const devServerUrl = process.env["VITE_DEV_SERVER_URL"] ?? "http://localhost:5173";
  if (isDev) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(process.resourcesPath, "renderer", "index.html"));
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ═══════════════════════════════════════════════════════════════════
// IPC ハンドラ（サイドカー再起動）
// ═══════════════════════════════════════════════════════════════════

function registerRestartSidecarIPC(): void {
  ipcMain.handle("restart-sidecar", async () => {
    try {
      await restartSidecar();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// アプリライフサイクル
// ═══════════════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  // IPC ハンドラ登録
  registerSyncHandlers();
  registerModelIPCHandlers();
  registerSidecarIPCHandlers();
  registerRestartSidecarIPC();
  registerSidecarPortIPC(() => sidecarPort);

  // 1. pipeline/ ディレクトリを初期化
  pipelineDir = await initPipelineDir();
  console.log(`[main] pipeline dir: ${pipelineDir}`);

  // 2. サイドカーを起動
  setSidecarStatus({ status: "starting", message: "Python サイドカーを起動中..." });
  try {
    await startSidecar();
  } catch (err) {
    console.error("[sidecar] spawn error:", err);
    setSidecarStatus({ status: "error", message: String(err) });
  }

  // 3. サイドカーの準備を待つ
  const ready = await waitForSidecar(sidecarPort, isDev ? 30_000 : 60_000);
  if (ready) {
    setSidecarStatus({ status: "ready", port: sidecarPort });
    console.log(`[sidecar] Ready on port ${sidecarPort}`);
  } else {
    setSidecarStatus({
      status: "unavailable",
      message: "タイムアウト。パイプライン機能は利用できません。",
    });
    console.warn("[sidecar] Timed out — pipeline unavailable");
  }

  // 4. api-server を起動
  startApiServer();

  // 5. ウィンドウを作成
  setTimeout(createWindow, isDev ? 0 : 800);
});

app.on("window-all-closed", () => {
  stopApiServer();
  stopSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  stopApiServer();
  stopSidecar();
});
