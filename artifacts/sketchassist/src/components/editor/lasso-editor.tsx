/**
 * lasso-editor.tsx
 *
 * 投げ縄選択コンポーネント。
 * 原本画像の上にポリゴンを手描きし、「含める」/「除外」の範囲を指定する。
 * 描かれた座標は元画像ピクセル座標系（整数）で返す。
 */

import { useRef, useEffect, useCallback } from "react";
import { X, Undo2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// ── 型 ──────────────────────────────────────────────────────────────────────

/** 元画像ピクセル座標の点 [x, y] */
export type LassoPoint = [number, number];

/** 1 本の投げ縄ストローク */
export interface LassoStroke {
  kind: "include" | "exclude";
  points: LassoPoint[];
}

interface LassoEditorProps {
  imageUrl: string;
  /** 元画像の自然幅（ピクセル） */
  imageW: number;
  /** 元画像の自然高（ピクセル） */
  imageH: number;
  strokes: LassoStroke[];
  activeKind: "include" | "exclude";
  onKindChange: (k: "include" | "exclude") => void;
  onStrokeAdd: (s: LassoStroke) => void;
  onUndo: () => void;
  onClear: () => void;
  onClose: () => void;
}

// ── コンポーネント ───────────────────────────────────────────────────────────

export function LassoEditor({
  imageUrl, imageW, imageH,
  strokes, activeKind,
  onKindChange, onStrokeAdd, onUndo, onClear, onClose,
}: LassoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const currentPath  = useRef<LassoPoint[]>([]);

  // ── 座標計算 ────────────────────────────────────────────────────────────

  /** コンテナ内でレターボックス表示された画像の矩形を返す */
  const getRect = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch || !imageW || !imageH) return null;
    const scale = Math.min(cw / imageW, ch / imageH);
    const dw    = imageW * scale;
    const dh    = imageH * scale;
    const ox    = (cw - dw) / 2;
    const oy    = (ch - dh) / 2;
    return { cw, ch, scale, dw, dh, ox, oy };
  }, [imageW, imageH]);

  /** コンテナ座標 → 元画像ピクセル座標（範囲外は null） */
  const toImgCoords = useCallback((cx: number, cy: number): LassoPoint | null => {
    const r = getRect();
    if (!r) return null;
    const ix = Math.round((cx - r.ox) / r.scale);
    const iy = Math.round((cy - r.oy) / r.scale);
    if (ix < 0 || ix > imageW || iy < 0 || iy > imageH) return null;
    return [ix, iy];
  }, [getRect, imageW, imageH]);

  // ── 描画 ────────────────────────────────────────────────────────────────

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const r      = getRect();
    if (!canvas || !r) return;

    canvas.width  = r.cw;
    canvas.height = r.ch;

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, r.cw, r.ch);

    const toCvs = (p: LassoPoint) =>
      [p[0] * r.scale + r.ox, p[1] * r.scale + r.oy] as const;

    const drawPoly = (
      pts: LassoPoint[],
      fillColor: string,
      strokeColor: string,
      dashed = false,
    ) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      const [sx, sy] = toCvs(pts[0]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < pts.length; i++) {
        const [px, py] = toCvs(pts[i]);
        ctx.lineTo(px, py);
      }
      if (!dashed) ctx.closePath();
      ctx.fillStyle = fillColor;
      if (!dashed) ctx.fill();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // 確定済みストローク
    for (const s of strokes) {
      const fill   = s.kind === "include" ? "rgba(0,200,80,0.22)"  : "rgba(220,50,50,0.22)";
      const border = s.kind === "include" ? "#22cc66"              : "#dd3333";
      drawPoly(s.points, fill, border);
    }

    // 描画中のストローク
    const cur = currentPath.current;
    if (cur.length >= 2) {
      const fill   = activeKind === "include" ? "rgba(0,200,80,0.10)" : "rgba(220,50,50,0.10)";
      const border = activeKind === "include" ? "#22cc66"             : "#dd3333";
      drawPoly(cur, fill, border, true);
    }
  }, [strokes, activeKind, getRect]);

  useEffect(() => { redraw(); }, [redraw]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [redraw]);

  // ── マウスイベント ──────────────────────────────────────────────────────

  const getPos = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = getPos(e);
    if (!pos) return;
    const pt = toImgCoords(pos.x, pos.y);
    if (!pt) return;
    isDrawingRef.current  = true;
    currentPath.current   = [pt];
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawingRef.current) return;
    const pos = getPos(e);
    if (!pos) return;
    const pt = toImgCoords(pos.x, pos.y);
    if (!pt) return;
    const last = currentPath.current.at(-1);
    // 密すぎる点は間引く
    if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 3) return;
    currentPath.current = [...currentPath.current, pt];
    redraw();
  };

  const handleMouseUp = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    const pts = currentPath.current;
    currentPath.current  = [];
    if (pts.length >= 3) {
      onStrokeAdd({ kind: activeKind, points: pts });
    } else {
      redraw();
    }
  };

  // ── 集計 ────────────────────────────────────────────────────────────────

  const includeCount = strokes.filter(s => s.kind === "include").length;
  const excludeCount = strokes.filter(s => s.kind === "exclude").length;

  // ── JSX ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">

      {/* ツールバー */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 h-9 border-b border-border bg-card">
        <span className="text-[10px] font-mono text-muted-foreground mr-0.5">投げ縄:</span>

        <button
          onClick={() => onKindChange("include")}
          className={[
            "px-2 py-0.5 rounded border text-[10px] font-mono transition-colors",
            activeKind === "include"
              ? "bg-green-500/20 border-green-500 text-green-600 dark:text-green-400"
              : "border-border text-muted-foreground hover:border-green-500/50",
          ].join(" ")}>
          ＋ 含める
        </button>

        <button
          onClick={() => onKindChange("exclude")}
          className={[
            "px-2 py-0.5 rounded border text-[10px] font-mono transition-colors",
            activeKind === "exclude"
              ? "bg-red-500/20 border-red-500 text-red-600 dark:text-red-400"
              : "border-border text-muted-foreground hover:border-red-500/50",
          ].join(" ")}>
          － 除外
        </button>

        <Separator orientation="vertical" className="h-4 mx-0.5" />

        <Button
          variant="ghost" size="icon" className="h-6 w-6"
          onClick={onUndo} title="直前のストロークを取り消す">
          <Undo2 className="w-3 h-3" />
        </Button>
        <Button
          variant="ghost" size="icon" className="h-6 w-6"
          onClick={onClear} title="全ストロークを消去">
          <Trash2 className="w-3 h-3" />
        </Button>

        <Separator orientation="vertical" className="h-4 mx-0.5" />

        <span className="text-[9px] font-mono text-muted-foreground">
          含む&nbsp;{includeCount}個 / 除外&nbsp;{excludeCount}個
        </span>

        <div className="flex-1" />

        <Button
          variant="ghost" size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          title="描画を終了してパネルに戻る">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* 描画エリア */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden bg-background"
        style={{ cursor: "crosshair" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* 元画像（レターボックス表示） */}
        <img
          src={imageUrl}
          alt="原本画像"
          className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
          draggable={false}
        />
        {/* 投げ縄オーバーレイ */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 pointer-events-none"
        />
        {/* ヒント */}
        {strokes.length === 0 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none">
            <span className="text-[9px] font-mono text-muted-foreground/70 bg-background/70 px-2 py-0.5 rounded">
              対象物をドラッグして囲んでください
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
