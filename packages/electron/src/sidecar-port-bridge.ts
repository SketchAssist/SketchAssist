/**
 * sidecar-port-bridge.ts
 *
 * Python サイドカーは起動のたびに findFreePort() で空きポートを動的に
 * 選ぶため(main.ts 参照)、ビルド時に固定される値(VITE_SIDECAR_URL 等)
 * だけでは、レンダラー側が「今回の起動で実際に使われているポート番号」を
 * 知る手段がない。このファイルは、その1点だけを解決するための最小限の
 * IPC橋渡しを提供する。
 *
 * 他のファイルとの関わり方(いずれも1行の呼び出しを追加するのみ):
 *   - main.ts    : registerSidecarPortIPC(() => sidecarPort) を1回呼ぶ
 *   - preload.ts : exposeSidecarPortBridge() を1回呼ぶ
 *   - レンダラー側(pipeline-api.ts 等): window.sketchAssistSidecar?.getPort()
 *     を呼んで取得する(Electron環境でない場合は window.sketchAssistSidecar
 *     自体が存在しないため、呼び出し側で existence チェックしてフォール
 *     バックすること)。
 *
 * 既存の window.electronAPI(preload.ts)とは意図的に独立させている。
 * electronAPI.getSidecarStatus() は状態遷移(starting/ready/error等)全体を
 * 扱う広い責務を持つのに対し、ここでは「現在のポート番号を1回問い合わせる」
 * という単一責務だけに絞ったチャンネルを用意し、既存の広いAPI面には
 * 手を加えないようにしている。
 */
import { ipcMain, contextBridge, ipcRenderer } from "electron";

/** このファイル専用のIPCチャンネル名(他のIPCハンドラと衝突しないよう専用の名前空間を使う) */
const GET_SIDECAR_PORT_CHANNEL = "sketchassist:get-sidecar-port";

/**
 * main プロセス側で1回呼ぶ。
 * getPort には、呼ばれた時点の最新のポート番号を返す関数を渡すこと
 * (サイドカー再起動でポートが変わり得るため、値ではなく関数として受け取る)。
 */
export function registerSidecarPortIPC(getPort: () => number): void {
  ipcMain.handle(GET_SIDECAR_PORT_CHANNEL, () => getPort());
}

/**
 * preload スクリプト側で1回呼ぶ。
 * レンダラーに `window.sketchAssistSidecar.getPort(): Promise<number>` を公開する。
 */
export function exposeSidecarPortBridge(): void {
  contextBridge.exposeInMainWorld("sketchAssistSidecar", {
    getPort: (): Promise<number> => ipcRenderer.invoke(GET_SIDECAR_PORT_CHANNEL),
  });
}
