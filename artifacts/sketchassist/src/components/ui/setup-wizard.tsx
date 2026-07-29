import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, ShieldCheck, AlertCircle, WifiOff } from "lucide-react";

// ── モデル定義 ─────────────────────────────────────────────────────
// packages/electron/src/models.ts と同期させること
const MODELS: {
  id: string;
  name: string;
  desc: string;
  sizeLabel: string;
  // Web シミュレーション用タイミング
  simStartMs: number;
  simDurationMs: number;
}[] = [
  { id: "sam2-tiny",  name: "SAM2 Tiny",      desc: "輪郭・インスタンス検出",  sizeLabel: "38 MB",  simStartMs: 500,  simDurationMs: 900  },
  { id: "clip-nano",  name: "CLIP Nano",       desc: "意味認識・部位ラベリング", sizeLabel: "82 MB",  simStartMs: 1100, simDurationMs: 1100 },
  { id: "potrace",    name: "Potrace Engine",  desc: "ベクター変換エンジン",    sizeLabel: "2 MB",   simStartMs: 2000, simDurationMs: 400  },
];

// ── 状態型 ────────────────────────────────────────────────────────
type ModelPhase =
  | "waiting"     // 待機
  | "checking"    // Electron: 存在確認中 / Web: アニメーション
  | "downloading" // Electron のみ: ダウンロード中
  | "ready"       // 完了
  | "error";      // エラー

interface ModelState {
  phase: ModelPhase;
  /** 0–100、downloading フェーズでのみ有効 */
  downloadPct: number;
  errorMsg?: string;
}

// ── ヘルパー ──────────────────────────────────────────────────────
const isElectron = !!window.electronAPI?.isElectron;

// ── SetupWizard ────────────────────────────────────────────────────
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [modelStates, setModelStates] = useState<ModelState[]>(
    MODELS.map(() => ({ phase: "waiting", downloadPct: 0 }))
  );
  const [allReady, setAllReady]   = useState(false);
  const [hasError, setHasError]   = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const setModelPhase = (i: number, updates: Partial<ModelState>) =>
    setModelStates(prev => {
      const next = [...prev];
      next[i] = { ...next[i], ...updates };
      return next;
    });

  // ── Electron モード ────────────────────────────────────────────
  useEffect(() => {
    if (!isElectron) return; // Web モードは別の useEffect で処理

    let cancelled = false;

    const run = async () => {
      // 進捗イベントを購読
      unsubRef.current = window.electronAPI!.onDownloadProgress(({ id, pct }) => {
        const i = MODELS.findIndex(m => m.id === id);
        if (i >= 0) setModelPhase(i, { phase: "downloading", downloadPct: pct });
      });

      // 各モデルを順番に処理（並列にすると帯域競合するため直列）
      let anyError = false;
      for (let i = 0; i < MODELS.length; i++) {
        if (cancelled) return;
        const model = MODELS[i];
        setModelPhase(i, { phase: "checking", downloadPct: 0 });

        try {
          // 存在確認
          const statuses = await window.electronAPI!.checkModels();
          const status   = statuses.find(s => s.id === model.id);

          if (status?.exists) {
            // 既にある → すぐ ready
            setModelPhase(i, { phase: "ready", downloadPct: 100 });
          } else {
            // ダウンロード開始
            setModelPhase(i, { phase: "downloading", downloadPct: 0 });
            await window.electronAPI!.downloadModel(model.id);
            setModelPhase(i, { phase: "ready", downloadPct: 100 });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setModelPhase(i, { phase: "error", errorMsg: msg });
          anyError = true;
          // エラーがあっても残りを続ける
        }
      }

      if (!anyError && !cancelled) {
        setTimeout(() => setAllReady(true), 250);
      } else {
        setHasError(true);
      }
    };

    run();
    return () => {
      cancelled = true;
      unsubRef.current?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Web シミュレーションモード ─────────────────────────────────
  useEffect(() => {
    if (isElectron) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    MODELS.forEach((m, i) => {
      timers.push(
        setTimeout(() => setModelPhase(i, { phase: "checking" }), m.simStartMs)
      );
      timers.push(
        setTimeout(() => {
          setModelPhase(i, { phase: "ready", downloadPct: 100 });
          if (i === MODELS.length - 1) setTimeout(() => setAllReady(true), 250);
        }, m.simStartMs + m.simDurationMs)
      );
    });
    return () => timers.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readyCount  = modelStates.filter(s => s.phase === "ready").length;
  const overallPct  = Math.round((readyCount / MODELS.length) * 100);
  const hasDownload = modelStates.some(s => s.phase === "downloading");

  // エラー時に再試行
  const handleRetry = () => {
    setHasError(false);
    setModelStates(MODELS.map(() => ({ phase: "waiting", downloadPct: 0 })));
    setAllReady(false);
    // useEffect を再実行するため key を使うより強制再マウントが必要だが、
    // 簡易実装として状態リセット後に run() を再呼び出し
    // → 実装を簡潔に保つため親からの再マウントを推奨。ここでは簡易リロード。
    window.location.reload();
  };

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-[400px] border-border bg-card gap-0 p-0 [&>button]:hidden"
        aria-describedby={undefined}
        onInteractOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
      >
        <DialogTitle className="sr-only">SketchAssist の初期設定</DialogTitle>

        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5 mb-1">
            <SketchAssistLogo className="w-5 h-5 text-primary shrink-0" />
            <h2 className="text-base font-semibold">SketchAssist の準備</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {isElectron
              ? <>処理に使うローカル AI モデルを確認・取得しています。<br />初回はダウンロードが発生する場合があります。</>
              : <>処理に使うローカル AI モデルを確認しています。<br />この操作は初回のみ行われます。</>
            }
          </p>
        </div>

        {/* Model list */}
        <div className="px-6 py-4 space-y-3">
          {MODELS.map((m, i) => {
            const s = modelStates[i];
            return (
              <div key={m.id} className="space-y-1">
                <div className="flex items-center gap-3">
                  {/* Icon */}
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                    {s.phase === "ready"       && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                    {(s.phase === "checking" || s.phase === "downloading")
                                               && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
                    {s.phase === "waiting"     && <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />}
                    {s.phase === "error"       && <AlertCircle className="w-4 h-4 text-destructive" />}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className={`text-xs font-medium transition-colors ${
                        s.phase === "ready"   ? "text-foreground" :
                        s.phase === "error"   ? "text-destructive" :
                        s.phase !== "waiting" ? "text-foreground" :
                        "text-muted-foreground"
                      }`}>{m.name}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{m.sizeLabel}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-none mt-0.5">{m.desc}</p>
                  </div>

                  {/* Status text */}
                  <span className={`text-[10px] shrink-0 font-medium transition-colors ${
                    s.phase === "ready"       ? "text-green-500" :
                    s.phase === "downloading" ? "text-primary" :
                    s.phase === "checking"    ? "text-primary" :
                    s.phase === "error"       ? "text-destructive" :
                    "text-muted-foreground/50"
                  }`}>
                    {s.phase === "ready"       ? "利用可能" :
                     s.phase === "downloading" ? `${s.downloadPct}%` :
                     s.phase === "checking"    ? "確認中" :
                     s.phase === "error"       ? "エラー" :
                     "待機"}
                  </span>
                </div>

                {/* ダウンロード中のみ進捗バー表示 */}
                {s.phase === "downloading" && (
                  <div className="ml-11 h-0.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${s.downloadPct}%` }}
                    />
                  </div>
                )}

                {/* エラーメッセージ */}
                {s.phase === "error" && s.errorMsg && (
                  <p className="ml-11 text-[10px] text-destructive leading-tight">{s.errorMsg}</p>
                )}
              </div>
            );
          })}

          {/* 全体プログレスバー */}
          {!hasDownload && (
            <div className="pt-1">
              <div className="h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${overallPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex flex-col gap-3">
          {/* オフライン警告（Electron のみ） */}
          {isElectron && hasError && (
            <div className="flex items-start gap-2 bg-destructive/8 border border-destructive/20 rounded-lg px-3 py-2.5">
              <WifiOff className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                ダウンロードに失敗しました。<br />
                ネットワーク接続を確認して再試行してください。
              </p>
            </div>
          )}

          {/* プライバシーノート */}
          {!hasError && (
            <div className="flex items-start gap-2 bg-primary/5 border border-primary/15 rounded-lg px-3 py-2.5">
              <ShieldCheck className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                すべての処理は端末内で完結します。<br />
                画像データは外部サーバーに一切送信されません。
              </p>
            </div>
          )}

          {hasError ? (
            <Button onClick={handleRetry} variant="outline" className="w-full">
              再試行
            </Button>
          ) : (
            <Button
              onClick={onComplete}
              disabled={!allReady}
              className="w-full"
            >
              {allReady ? "開始する" : (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {hasDownload ? "ダウンロード中…" : "確認中…"}
                </>
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── SketchAssist ロゴアイコン ────────────────────────────────────
function SketchAssistLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 19c-4 0-7-3-7-7s3-7 7-7 7 3 7 7" />
      <path d="M12 5v2M5.5 7.5l1.4 1.4M19 12h-2" />
      <path d="M15 15l3 3" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}
