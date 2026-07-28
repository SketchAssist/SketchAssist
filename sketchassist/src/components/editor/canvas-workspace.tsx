import { useEffect, useRef, useState, useCallback } from "react";
import { type Project, type AnnotationData, type Stroke, StrokeTool, useSaveAnnotations } from "@/lib/use-projects";
import { X, Pencil } from "lucide-react";
import type { MaskTool } from "@/lib/mask-editor";

type ViewTab = "original" | "step2" | "step3" | "step4" | "lineart" | "corrected" | "mask" | null;

interface CanvasWorkspaceProps {
  project: Project;
  annotations: AnnotationData | null;
  activeTool: "select" | "pen" | "eraser" | "text" | "scale" | "region_fg" | "region_bg" | "region_support";
  currentColor: string;
  currentWidth: number;
  undoTrigger: number;
  onScaleMeasured?: (info: { pixels: number; x1: number; y1: number; x2: number; y2: number }) => void;
  /** Called when a scale annotation is undone so the parent can also clear project scale settings. */
  onScaleAnnotationUndone?: () => void;
  /** Increment to clear all region marks */
  clearRegionTrigger?: number;
  /** Which view tab is active (null = no image loaded) */
  viewTab?: ViewTab;
  /** Intermediate step output image to display (step2 / step3 / step4) */
  intermediateImageUrl?: string;
  /**
   * Background reference image for the "corrected" (手書き修正) tab.
   * Shown semi-transparently as a tracing guide beneath the annotation drawing layer.
   * User selects which stage image (1–3) to use; defaults to Stage 3 edge output.
   */
  correctionBgUrl?: string;
  /**
   * 手書き修正タブの annotation canvas 初期化用ドラフト画像。
   * 白ピクセル → 透明、それ以外 → 不透明に変換して下書きレイヤとして利用する。
   */
  correctionDraftUrl?: string;
  /** 手書き修正タブ: 背景レイヤの表示/非表示 (default: true) */
  correctionBgVisible?: boolean;
  /** 手書き修正タブ: 前景 canvas (下書き+ストローク) の表示/非表示 (default: true) */
  correctionDraftVisible?: boolean;
  /**
   * 手書き修正タブ: インクリメントするたびに annotation canvas を
   * リセットする。ユーザーストロークと undo 履歴を全消去する。
   */
  correctionResetKey?: number;
  /** Mask preview image (original with red overlay on background). Shown in "mask" viewTab. */
  maskPreviewUrl?: string;
  /** User seed points to display as colored dots when in mask view */
  maskSeeds?: Array<{ type: 'fg' | 'bg' | 'support'; xPct: number; yPct: number }>;
  /** Current mask brush mode displayed as cursor hint (legacy, for seed tools) */
  maskBrush?: 'fg' | 'bg' | 'support';
  /** Active mask editing tool (seed, brush, flood, lasso) */
  maskTool?: MaskTool;
  /** Brush radius in IMAGE pixels (for brush keep/delete tools) */
  brushRadius?: number;
  /** Pixel dimensions of the mask image (for canvas→image coordinate conversion) */
  maskImageWidth?: number;
  maskImageHeight?: number;
  /** Current lasso polygon in IMAGE pixel coordinates (for overlay rendering) */
  lassoImagePoints?: Array<{ x: number; y: number }>;
  /** Called when user places a seed in mask view — percentage coords within image space */
  onMaskSeedClick?: (xPct: number, yPct: number) => void;
  /** Called with image pixel coordinates for each brush paint point */
  onMaskBrushPoint?: (imageX: number, imageY: number) => void;
  /** Called when brush stroke ends */
  onMaskBrushEnd?: () => void;
  /** Called with image pixel coordinates for flood delete */
  onMaskFloodDelete?: (imageX: number, imageY: number) => void;
  /** Called with image pixel coordinates for flood keep */
  onMaskFloodKeep?: (imageX: number, imageY: number) => void;
  /** Called with image pixel coordinates for each lasso polygon point */
  onMaskLassoPoint?: (imageX: number, imageY: number) => void;
  /** Called when lasso selection is closed (mouse released) */
  onMaskLassoClose?: () => void;
  /** Called whenever the canvas container is resized */
  onDimensionsChange?: (width: number, height: number) => void;
  /**
   * Text annotations injected from the parent (e.g. AI part recognition labels).
   * The component merges them into local state and persists them once on mount.
   */
  pendingAnnotations?: TextAnnotation[];
  /** Called after pendingAnnotations have been merged and saved */
  onPendingAnnotationsApplied?: () => void;
}

export type TextAnnotation = NonNullable<AnnotationData["textAnnotations"]>[number];

export function CanvasWorkspace({
  project, annotations, activeTool, currentColor, currentWidth, undoTrigger,
  onScaleMeasured, onScaleAnnotationUndone, clearRegionTrigger = 0, viewTab = null, intermediateImageUrl,
  correctionBgUrl, correctionDraftUrl, correctionBgVisible = true, correctionDraftVisible = true, correctionResetKey = 0,
  maskPreviewUrl, maskSeeds = [], maskBrush = 'bg', maskTool = 'seed_fg',
  brushRadius = 15, maskImageWidth, maskImageHeight, lassoImagePoints = [],
  onMaskSeedClick, onMaskBrushPoint, onMaskBrushEnd, onMaskFloodDelete, onMaskFloodKeep,
  onMaskLassoPoint, onMaskLassoClose,
  onDimensionsChange, pendingAnnotations, onPendingAnnotationsApplied,
}: CanvasWorkspaceProps) {
  const isViewMode = viewTab !== null;
  const containerRef      = useRef<HTMLDivElement>(null);
  const baseCanvasRef     = useRef<HTMLCanvasElement>(null);
  const lineartCanvasRef  = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef  = useRef<HTMLCanvasElement>(null);
  /** Tracks where the image is letterboxed inside the canvas (for mask click conversion). */
  const imgBoundsRef = useRef<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 0, h: 0 });
  /**
   * Offscreen canvas holding the pixel-normalized edge map of the 部位マップ.
   * Stored as a ref so drawAnnotations can draw it as an erasable background
   * layer in the corrected tab without triggering extra re-renders.
   */
  const normalizedEdgeMapRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * Counter bumped whenever normalizedEdgeMapRef.current is updated.
   * Including it in drawAnnotations' deps ensures the canvas redraws once the
   * edge map is ready (since ref mutations alone don't trigger useCallback).
   */
  const [edgeMapVersion, setEdgeMapVersion] = useState(0);

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const saveAnnotations = useSaveAnnotations();

  const [isDrawing,      setIsDrawing]      = useState(false);
  /** Ref mirror of isDrawing — avoids stale-closure bugs in pointer handlers. */
  const isDrawingRef = useRef(false);
  /** Active stroke points — stored in a ref to avoid React re-renders during drawing. */
  const currentStrokeRef  = useRef<number[]>([]);
  /** Separate canvas for the in-progress stroke — clears/redraws without touching committed strokes. */
  const liveStrokeCanvasRef = useRef<HTMLCanvasElement>(null);
  /** requestAnimationFrame handle — non-null while a stroke is being drawn. */
  const rafIdRef = useRef<number | null>(null);
  const [localStrokes,   setLocalStrokes]   = useState<Stroke[]>([]);
  /** ID of the stroke the user has selected (via "select" tool click) for deletion. */
  const [selectedStrokeId, setSelectedStrokeId] = useState<string | null>(null);
  /** Canvas-space position to anchor the floating delete button for the selected stroke. */
  const [selectedStrokeAnchor, setSelectedStrokeAnchor] = useState<{x:number;y:number}|null>(null);
  const [localTextAnnotations, setLocalTextAnnotations] = useState<TextAnnotation[]>([]);

  // Keep refs to the latest strokes/textAnnotations for use in async/drag callbacks
  const localStrokesRef = useRef<Stroke[]>([]);
  useEffect(() => { localStrokesRef.current = localStrokes; }, [localStrokes]);

  const localTextAnnotationsRef = useRef<TextAnnotation[]>([]);
  useEffect(() => { localTextAnnotationsRef.current = localTextAnnotations; }, [localTextAnnotations]);

  // Combined undo history: tracks order of strokes and text/scale annotations added
  const undoHistoryRef = useRef<Array<{ kind: "stroke" | "annotation"; id: string }>>([]);

  // Scale tool
  const [scaleStart, setScaleStart] = useState<{ x: number; y: number } | null>(null);
  const [scaleEnd,   setScaleEnd]   = useState<{ x: number; y: number } | null>(null);

  // Text editing — unified state (no separate "new" vs "edit" split)
  const [editingAnnotId,    setEditingAnnotId]    = useState<string | null>(null);
  const [editingAnnotValue, setEditingAnnotValue] = useState("");
  /** true when the annotation was just created and has no committed text yet */
  const editingIsNewRef = useRef(false);
  const editInputRef    = useRef<HTMLInputElement>(null);

  // Text: dragging/moving
  const [draggingText, setDraggingText] = useState<{
    id: string;
    startClientX: number; startClientY: number;
    origX: number; origY: number;
    startZoom: number;
    moved: boolean;
  } | null>(null);

  // Region marks
  const [regionMarks, setRegionMarks] = useState<{ x: number; y: number; kind: "fg" | "bg" | "support" }[]>([]);

  // ── Mask direct-edit tool state ──────────────────────────────────────────
  const [isMaskBrushing, setIsMaskBrushing] = useState(false);
  const [isLassoing,     setIsLassoing]     = useState(false);
  /** Canvas-space lasso points (for local rendering; image-space via callback) */
  const [lassoCanvasPoints, setLassoCanvasPoints] = useState<Array<{x:number;y:number}>>([]);
  /** Canvas-space position of the brush cursor (for cursor ring rendering) */
  const [brushCanvasPos, setBrushCanvasPos] = useState<{x:number;y:number}|null>(null);
  const lastLassoCanvasPoint = useRef<{x:number;y:number}|null>(null);

  // ── Pan / zoom viewport ──────────────────────────────────────────────────
  const [isPanDragging, setIsPanDragging] = useState(false);
  const [viewport, setViewport] = useState({ zoom: 1.0, panX: 0, panY: 0 });
  const viewportRef = useRef({ zoom: 1.0, panX: 0, panY: 0 });
  viewportRef.current = viewport;
  const panDragRef = useRef<{
    startMouseX: number; startMouseY: number;
    startPanX: number;   startPanY: number;
  } | null>(null);

  const prevUndoTrigger        = useRef(0);
  const prevClearRegionTrigger = useRef(0);

  // Guard: only sync annotations from server on first successful load
  const annotationsInitialized = useRef(false);

  // Resize observer — also notifies parent so label positions can be computed
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
      onDimensionsChange?.(width, height);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync annotations from server ONCE on first load only.
  // React Query refetches on window-focus by default; without this guard the
  // refetch would overwrite local edits that haven't been persisted yet.
  useEffect(() => {
    if (!annotations) return;
    if (annotationsInitialized.current) return;
    annotationsInitialized.current = true;
    setLocalStrokes(annotations.strokes ?? []);
    setLocalTextAnnotations(annotations.textAnnotations ?? []);
  }, [annotations]);

  // Undo last stroke or annotation (combined history)
  useEffect(() => {
    if (undoTrigger === 0 || undoTrigger === prevUndoTrigger.current) return;
    prevUndoTrigger.current = undoTrigger;
    const last = undoHistoryRef.current.pop();
    if (!last) return;
    if (last.kind === "stroke") {
      const next = localStrokesRef.current.filter(s => s.id !== last.id);
      setLocalStrokes(next);
      saveAnnotations.mutate({
        id: project.id,
        data: { projectId: project.id, strokes: next, textAnnotations: localTextAnnotationsRef.current },
      });
    } else {
      const removed = localTextAnnotationsRef.current.find(a => a.id === last.id);
      const next = localTextAnnotationsRef.current.filter(a => a.id !== last.id);
      setLocalTextAnnotations(next);
      if (removed?.kind === "scale") {
        onScaleAnnotationUndone?.();
        setScaleStart(null);
        setScaleEnd(null);
      }
      saveAnnotations.mutate({
        id: project.id,
        data: { projectId: project.id, strokes: localStrokesRef.current, textAnnotations: next },
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoTrigger]);

  // Clear region marks when trigger increments
  useEffect(() => {
    if (clearRegionTrigger === 0 || clearRegionTrigger === prevClearRegionTrigger.current) return;
    prevClearRegionTrigger.current = clearRegionTrigger;
    setRegionMarks([]);
  }, [clearRegionTrigger]);

  // Non-passive wheel handler for zoom (centered on cursor)
  useEffect(() => {
    const outer = containerRef.current;
    if (!outer) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = outer.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;
      setViewport(prev => {
        const factor  = e.deltaY < 0 ? 1.25 : 1 / 1.25;
        const newZoom = Math.max(0.25, Math.min(8, prev.zoom * factor));
        return {
          zoom: newZoom,
          panX: mx - (mx - prev.panX) * newZoom / prev.zoom,
          panY: my - (my - prev.panY) * newZoom / prev.zoom,
        };
      });
    };
    outer.addEventListener("wheel", onWheel, { passive: false });
    return () => outer.removeEventListener("wheel", onWheel);
  }, []);

  // Reset viewport when switching projects
  useEffect(() => {
    setViewport({ zoom: 1.0, panX: 0, panY: 0 });
  }, [project.id]);

  // Merge AI-generated annotations (e.g. part recognition labels) into local state.
  // Runs whenever the parent pushes a new pendingAnnotations array.
  useEffect(() => {
    if (!pendingAnnotations?.length) return;
    const existingIds = new Set(localTextAnnotationsRef.current.map(a => a.id));
    const toAdd = pendingAnnotations.filter(a => !existingIds.has(a.id));
    if (!toAdd.length) { onPendingAnnotationsApplied?.(); return; }
    const updated = [...localTextAnnotationsRef.current, ...toAdd];
    setLocalTextAnnotations(updated);
    for (const a of toAdd) undoHistoryRef.current.push({ kind: "annotation", id: a.id });
    // If any of the new annotations is a scale annotation, clear the yellow preview line
    if (toAdd.some(a => a.kind === "scale")) {
      setScaleStart(null);
      setScaleEnd(null);
    }
    saveAnnotations.mutate({
      id: project.id,
      data: { projectId: project.id, strokes: localStrokesRef.current, textAnnotations: updated },
    });
    onPendingAnnotationsApplied?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnnotations]);

  // Draw base image (original photo, intermediate step result, mask preview, or
  // correction background).
  // For step2/3/4 tabs the intermediate image replaces the original.
  // For the "mask" tab the mask preview image is shown.
  // ── draft → annotation canvas initializer ────────────────────────
  // ドラフト画像を手書き修正の下書きレイヤとして利用する。
  // 白背景 (>230) → 透明、その他のピクセル → 不透明に変換して
  // normalizedEdgeMapRef に保持する。ペン/消しゴムはこの層を含めて操作できる。
  useEffect(() => {
    if (!correctionDraftUrl) { normalizedEdgeMapRef.current = null; setEdgeMapVersion(v => v + 1); return; }
    const img = new Image();
    img.onload = () => {
      const W = img.width, H = img.height;
      const off = document.createElement("canvas");
      off.width = W; off.height = H;
      const offCtx = off.getContext("2d")!;
      offCtx.drawImage(img, 0, 0);
      const { data: src } = offCtx.getImageData(0, 0, W, H);
      // 白背景 (R,G,B すべて >230) → 透明。それ以外は元色をそのまま保持。
      // Stage 6 の黒/灰 2 色をそのまま Stage 7 に引き継ぐため、色を変換しない。
      const isBg = (i: number) => src[i] > 230 && src[i+1] > 230 && src[i+2] > 230;
      const out = new Uint8ClampedArray(src.length);
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 4;
          if (isBg(i)) {
            // 背景あり: 白→透明(参照背景が透けて見える)
            // 背景なし: 白→不透明白(白紙に線を引いた状態)
            out[i]=255; out[i+1]=255; out[i+2]=255;
            out[i+3] = correctionBgVisible ? 0 : 255;
          } else {
            out[i]=src[i]; out[i+1]=src[i+1]; out[i+2]=src[i+2];  // 元色を維持
            out[i+3]=220;
          }
        }
      }
      offCtx.putImageData(new ImageData(out, W, H), 0, 0);
      normalizedEdgeMapRef.current = off;
      setEdgeMapVersion(v => v + 1);
    };
    img.src = correctionDraftUrl;
  // correctionResetKey を依存に含めることで、初期化ボタンを押すたびに
  // 同じ URL でも画像を再ロード・再正規化する。
  }, [correctionDraftUrl, correctionResetKey, correctionBgVisible]);

  // ── 手書き修正: 初期化 ────────────────────────────────────────────────────
  // correctionResetKey がインクリメントされるたびにユーザーストロークと undo 履歴を消去。
  // 画像の再ロードは上の normalizedEdgeMap useEffect が担うので ここでは不要。
  useEffect(() => {
    if (correctionResetKey === 0) return;        // マウント時は無視
    setLocalStrokes([]);
    undoHistoryRef.current = [];
    setSelectedStrokeId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionResetKey]);

  // ── Base canvas drawing ───────────────────────────────────────────────────
  // For the "corrected" tab the base canvas shows only a white background;
  // the edge map lives on the annotation canvas so the eraser can remove it.
  useEffect(() => {
    if (!baseCanvasRef.current) return;
    const isIntermediateTab = viewTab === "step2" || viewTab === "step3" || viewTab === "step4";
    const isMaskTab        = viewTab === "mask";
    const isCorrectedTab   = viewTab === "corrected";
    const ctx = baseCanvasRef.current.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    if (isCorrectedTab) {
      // 背景なし時は白地を敷く。背景あり時は透明のまま（参照画像のみ半透明で重ねる）。
      if (!correctionBgVisible) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, dimensions.width, dimensions.height);
      }
      if (correctionBgVisible && correctionBgUrl) {
        const bgImg = new Image();
        bgImg.onload = () => {
          const scale = Math.min(dimensions.width / bgImg.width, dimensions.height / bgImg.height);
          const dx = (dimensions.width  - bgImg.width  * scale) / 2;
          const dy = (dimensions.height - bgImg.height * scale) / 2;
          ctx.save();
          ctx.globalAlpha = 0.42;
          ctx.drawImage(bgImg, dx, dy, bgImg.width * scale, bgImg.height * scale);
          ctx.restore();
          imgBoundsRef.current = { x: dx, y: dy, w: bgImg.width * scale, h: bgImg.height * scale };
        };
        bgImg.src = correctionBgUrl;
      }
      return;
    }

    const urlToShow =
      isMaskTab         ? maskPreviewUrl :
      isIntermediateTab ? intermediateImageUrl :
      project.imageUrl;
    if (!urlToShow) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, dimensions.width, dimensions.height);
      const scale = Math.min(dimensions.width / img.width, dimensions.height / img.height);
      const dx = (dimensions.width  - img.width  * scale) / 2;
      const dy = (dimensions.height - img.height * scale) / 2;
      ctx.drawImage(img, dx, dy, img.width * scale, img.height * scale);
      imgBoundsRef.current = { x: dx, y: dy, w: img.width * scale, h: img.height * scale };
    };
    img.src = urlToShow;
  }, [project.imageUrl, intermediateImageUrl, maskPreviewUrl, correctionBgUrl, correctionBgVisible, viewTab, dimensions]);

  // Draw line art
  useEffect(() => {
    if (!lineartCanvasRef.current) return;
    const ctx = lineartCanvasRef.current.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    if (!project.lineArtUrl) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(dimensions.width / img.width, dimensions.height / img.height);
      const x = (dimensions.width - img.width * scale) / 2;
      const y = (dimensions.height - img.height * scale) / 2;
      ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
    };
    img.src = project.lineArtUrl;
  }, [project.lineArtUrl, dimensions]);

  // ── Smooth curve helper ────────────────────────────────────────────────────
  /**
   * Draw a smooth stroke using quadratic Bézier curves with midpoint anchors.
   * This avoids the jagged look of lineTo-only rendering without requiring
   * pressure data or spline libraries.
   */
  const drawSmoothPath = useCallback((
    ctx: CanvasRenderingContext2D,
    points: number[],
    color: string,
    width: number,
    isEraser: boolean,
  ) => {
    if (points.length < 2) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width;

    if (isEraser) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = color;
    }

    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);

    if (points.length === 2) {
      // Single dot
      ctx.arc(points[0], points[1], width / 2, 0, Math.PI * 2);
      ctx.fillStyle = isEraser ? "rgba(0,0,0,1)" : color;
      ctx.fill();
    } else if (points.length === 4) {
      ctx.lineTo(points[2], points[3]);
      ctx.stroke();
    } else {
      // Move to first midpoint, then arc through each control point via midpoints
      const mx0 = (points[0] + points[2]) / 2;
      const my0 = (points[1] + points[3]) / 2;
      ctx.lineTo(mx0, my0);
      for (let i = 2; i < points.length - 2; i += 2) {
        const mx = (points[i] + points[i + 2]) / 2;
        const my = (points[i + 1] + points[i + 3]) / 2;
        ctx.quadraticCurveTo(points[i], points[i + 1], mx, my);
      }
      // Connect to the final point
      const n = points.length;
      ctx.quadraticCurveTo(points[n - 4], points[n - 3], points[n - 2], points[n - 1]);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = "source-over";
  }, []);

  // ── Stroke hit-test helper ────────────────────────────────────────────────
  /** Minimum distance from a point to a line segment (p→(a,b)). */
  const ptSegDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  /** Returns the stroke ID under canvas-point (cx,cy), or null. */
  const hitTestStrokes = useCallback((cx: number, cy: number): string | null => {
    for (let s = localStrokesRef.current.length - 1; s >= 0; s--) {
      const stroke = localStrokesRef.current[s];
      const pts = stroke.points;
      const threshold = Math.max(stroke.width / 2 + 6, 8);
      if (pts.length === 2 && Math.hypot(cx - pts[0], cy - pts[1]) < threshold) return stroke.id;
      for (let i = 0; i < pts.length - 2; i += 2) {
        if (ptSegDist(cx, cy, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) < threshold) return stroke.id;
      }
    }
    return null;
  }, []);

  // Draw committed annotation strokes.
  // In the "corrected" tab the normalized edge map is drawn first as an
  // erasable background layer; user strokes (pen/eraser) are drawn on top.
  // Eraser strokes (destination-out) therefore remove pixels from both the
  // edge map and any pen strokes that were drawn before them.
  const drawAnnotations = useCallback(() => {
    if (!annotationCanvasRef.current) return;
    const ctx = annotationCanvasRef.current.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    // ── Corrected tab: draw edge map as erasable base ──────────────────────
    if (viewTab === "corrected" && normalizedEdgeMapRef.current) {
      const em = normalizedEdgeMapRef.current;
      const scale = Math.min(dimensions.width / em.width, dimensions.height / em.height);
      const ex = (dimensions.width  - em.width  * scale) / 2;
      const ey = (dimensions.height - em.height * scale) / 2;
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(em, ex, ey, em.width * scale, em.height * scale);
      ctx.restore();
    }

    localStrokes.forEach(stroke => {
      if (stroke.points.length < 2) return;
      // Amber glow behind the selected stroke
      if (stroke.id === selectedStrokeId) {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = stroke.width + 8;
        ctx.strokeStyle = "rgba(251,191,36,0.55)";
        const pts = stroke.points;
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        ctx.stroke();
        ctx.restore();
      }
      drawSmoothPath(ctx, stroke.points, stroke.color, stroke.width, stroke.tool === StrokeTool.eraser);
    });
  // edgeMapVersion triggers a redraw when normalizedEdgeMapRef.current is updated
  }, [localStrokes, dimensions, drawSmoothPath, selectedStrokeId, viewTab, edgeMapVersion]);

  useEffect(() => { drawAnnotations(); }, [drawAnnotations]);

  // ── Live stroke (RAF loop) ─────────────────────────────────────────────────
  /** Draw the in-progress stroke onto the dedicated live-stroke canvas. */
  const drawLiveStroke = useCallback(() => {
    const canvas = liveStrokeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pts = currentStrokeRef.current;
    if (pts.length < 2) return;
    const isEraser = activeTool === "eraser";
    // Eraser preview on the live canvas: draw a light indicator (actual erase happens on annotationCanvas at commit)
    drawSmoothPath(ctx, pts, isEraser ? "rgba(180,180,180,0.55)" : currentColor, currentWidth, false);
  }, [activeTool, currentColor, currentWidth, drawSmoothPath]);

  /** Start the RAF rendering loop for the live stroke. */
  const startLiveStrokeLoop = useCallback(() => {
    const loop = () => {
      drawLiveStroke();
      rafIdRef.current = requestAnimationFrame(loop);
    };
    rafIdRef.current = requestAnimationFrame(loop);
  }, [drawLiveStroke]);

  /** Stop the RAF loop and clear the live-stroke canvas. */
  const stopLiveStrokeLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const canvas = liveStrokeCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  /**
   * Convert canvas-space coords to image-pixel coords.
   * @param clamp  If true, clamps out-of-bounds points to the image edge instead of
   *               returning null. Use for lasso so polygon vertices are never dropped.
   *               If false (default), returns null when outside the image area.
   */
  const canvasToImage = useCallback((cx: number, cy: number, clamp = false): {x:number;y:number}|null => {
    const { x: bx, y: by, w: bw, h: bh } = imgBoundsRef.current;
    if (!bw || !bh || !maskImageWidth || !maskImageHeight) return null;
    const ix = (cx - bx) / bw * maskImageWidth;
    const iy = (cy - by) / bh * maskImageHeight;
    if (!clamp && (ix < 0 || ix >= maskImageWidth || iy < 0 || iy >= maskImageHeight)) return null;
    return {
      x: Math.round(clamp ? Math.max(0, Math.min(maskImageWidth  - 1, ix)) : ix),
      y: Math.round(clamp ? Math.max(0, Math.min(maskImageHeight - 1, iy)) : iy),
    };
  }, [maskImageWidth, maskImageHeight]);

  /** Convert image-pixel coords to canvas-space coords. */
  const imageToCanvas = useCallback((ix: number, iy: number): {x:number;y:number} => {
    const { x: bx, y: by, w: bw, h: bh } = imgBoundsRef.current;
    return {
      x: bx + (ix / (maskImageWidth || 1)) * bw,
      y: by + (iy / (maskImageHeight || 1)) * bh,
    };
  }, [maskImageWidth, maskImageHeight]);

  // Overlay: scale line + region marks + mask seed dots + brush cursor + lasso
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    // ── Brush cursor ring ──────────────────────────────────────────────────
    if (viewTab === "mask" && brushCanvasPos &&
        (maskTool === 'brush_keep' || maskTool === 'brush_delete')) {
      const { w: bw } = imgBoundsRef.current;
      const canvasRadius = maskImageWidth ? brushRadius * bw / maskImageWidth : brushRadius;
      ctx.beginPath();
      ctx.arc(brushCanvasPos.x, brushCanvasPos.y, Math.max(2, canvasRadius), 0, Math.PI * 2);
      ctx.strokeStyle = maskTool === 'brush_keep' ? "rgba(80,200,80,0.85)" : "rgba(200,60,60,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Cross-hair center
      ctx.beginPath();
      ctx.arc(brushCanvasPos.x, brushCanvasPos.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = maskTool === 'brush_keep' ? "rgba(80,200,80,0.9)" : "rgba(200,60,60,0.9)";
      ctx.fill();
    }

    // ── Lasso polygon preview ──────────────────────────────────────────────
    if (viewTab === "mask" && lassoCanvasPoints.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(lassoCanvasPoints[0].x, lassoCanvasPoints[0].y);
      lassoCanvasPoints.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = maskTool === 'lasso_keep' ? "rgba(80,220,80,0.9)" : "rgba(220,60,60,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Start dot
      ctx.beginPath();
      ctx.arc(lassoCanvasPoints[0].x, lassoCanvasPoints[0].y, 4, 0, Math.PI * 2);
      ctx.fillStyle = maskTool === 'lasso_keep' ? "#4de88e" : "#e84d4d";
      ctx.fill();
    }

    // ── Parent-supplied lasso polygon (image coords → canvas coords) ────────
    if (viewTab === "mask" && lassoImagePoints.length >= 2 && !isLassoing) {
      const pts = lassoImagePoints.map(p => imageToCanvas(p.x, p.y));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = maskTool === 'lasso_keep' ? "rgba(80,220,80,0.7)" : "rgba(220,60,60,0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw mask seed dots when in mask view
    if (viewTab === "mask" && maskSeeds.length > 0) {
      const { x: bx, y: by, w: bw, h: bh } = imgBoundsRef.current;
      maskSeeds.forEach(seed => {
        const cx = bx + seed.xPct / 100 * bw;
        const cy = by + seed.yPct / 100 * bh;
        // Three-class colour coding:
        //   green  = 研究対象 (subject to keep)
        //   orange = 支持体  (substrate/mount — excluded but semantically distinct)
        //   red    = 背景    (background — excluded)
        const dotColor =
          seed.type === 'fg'      ? "rgba(0,220,80,0.90)" :
          seed.type === 'support' ? "rgba(245,130,0,0.90)" :
                                    "rgba(220,40,40,0.90)";
        const label =
          seed.type === 'fg'      ? "✓" :
          seed.type === 'support' ? "S"  :
                                    "✕";
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, cx, cy);
      });
    }

    regionMarks.forEach(m => {
      ctx.beginPath();
      ctx.arc(m.x, m.y, 8, 0, Math.PI * 2);
      ctx.fillStyle =
        m.kind === "fg"      ? "rgba(0,200,80,0.7)" :
        m.kind === "support" ? "rgba(245,130,0,0.7)" :
                               "rgba(220,50,50,0.7)";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(m.kind === "fg" ? "F" : m.kind === "support" ? "S" : "B", m.x, m.y);
    });

    if (scaleStart && scaleEnd) {
      ctx.beginPath();
      ctx.moveTo(scaleStart.x, scaleStart.y);
      ctx.lineTo(scaleEnd.x, scaleEnd.y);
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      [scaleStart, scaleEnd].forEach(pt => {
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#f59e0b"; ctx.fill();
      });
      const dx = scaleEnd.x - scaleStart.x, dy = scaleEnd.y - scaleStart.y;
      const px = Math.round(Math.sqrt(dx * dx + dy * dy));
      ctx.fillStyle = "#f59e0b";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${px}px`, (scaleStart.x + scaleEnd.x) / 2, (scaleStart.y + scaleEnd.y) / 2 - 4);
    } else if (scaleStart && isDrawing) {
      ctx.beginPath(); ctx.arc(scaleStart.x, scaleStart.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#f59e0b"; ctx.fill();
    }

  }, [regionMarks, scaleStart, scaleEnd, isDrawing, dimensions, maskSeeds, viewTab,
      brushCanvasPos, maskTool, brushRadius, maskImageWidth, maskImageHeight,
      lassoCanvasPoints, lassoImagePoints, isLassoing, imageToCanvas]);

  const cursorStyle: React.CSSProperties["cursor"] =
    isPanDragging ? "grabbing"
    : viewTab === "mask"
      ? (maskTool === 'brush_keep' || maskTool === 'brush_delete'
          ? "none"                            // brush: custom cursor drawn in overlay
          : maskTool === 'lasso_keep' || maskTool === 'lasso_delete'
            ? "crosshair"
            : maskTool === 'flood_delete'
              ? "cell"
              : maskTool === 'flood_keep'
                ? "cell"
                : (maskBrush === 'fg' ? "cell" : "crosshair")) // seed tools
    : activeTool === "select" ? "default"
    : activeTool === "text" ? "text"
    : activeTool === "scale" ? "crosshair"
    : activeTool === "region_fg" || activeTool === "region_bg" || activeTool === "region_support" ? "cell"
    : "crosshair";

  // ── Mask view pointer handlers ────────────────────────────────────────────

  const handleMaskPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Middle mouse: start pan (works in all view modes)
    if (e.button === 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
      panDragRef.current = { startMouseX: e.clientX, startMouseY: e.clientY, startPanX: viewportRef.current.panX, startPanY: viewportRef.current.panY };
      setIsPanDragging(true);
      return;
    }
    if (e.button !== 0) return;
    if (viewTab !== "mask") return;
    // Reverse the viewport transform to get canvas-pixel coords
    const outerRect = containerRef.current!.getBoundingClientRect();
    const cx = (e.clientX - outerRect.left - viewportRef.current.panX) / viewportRef.current.zoom;
    const cy = (e.clientY - outerRect.top  - viewportRef.current.panY) / viewportRef.current.zoom;
    const { x: bx, y: by, w: bw, h: bh } = imgBoundsRef.current;
    if (!bw || !bh) return;

    if (maskTool === 'seed_fg' || maskTool === 'seed_support' || maskTool === 'seed_bg') {
      // Seed placement (percentage coords, same as before)
      const xPct = (cx - bx) / bw * 100;
      const yPct = (cy - by) / bh * 100;
      if (xPct >= 0 && xPct <= 100 && yPct >= 0 && yPct <= 100) {
        onMaskSeedClick?.(xPct, yPct);
      }
      return;
    }

    const imgPt = canvasToImage(cx, cy);

    if (maskTool === 'flood_delete') {
      if (imgPt) onMaskFloodDelete?.(imgPt.x, imgPt.y);
      return;
    }

    if (maskTool === 'flood_keep') {
      if (imgPt) onMaskFloodKeep?.(imgPt.x, imgPt.y);
      return;
    }

    if (maskTool === 'brush_keep' || maskTool === 'brush_delete') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsMaskBrushing(true);
      setBrushCanvasPos({ x: cx, y: cy });
      if (imgPt) onMaskBrushPoint?.(imgPt.x, imgPt.y);
      return;
    }

    if (maskTool === 'lasso_keep' || maskTool === 'lasso_delete') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsLassoing(true);
      setLassoCanvasPoints([{ x: cx, y: cy }]);
      lastLassoCanvasPoint.current = { x: cx, y: cy };
      // Clamp: always emit a point (clamped to image edge) so the polygon is never truncated.
      const lassoImgPt = canvasToImage(cx, cy, true);
      if (lassoImgPt) onMaskLassoPoint?.(lassoImgPt.x, lassoImgPt.y);
      return;
    }
  };

  const handleMaskPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Pan drag
    if (panDragRef.current) {
      const dx = e.clientX - panDragRef.current.startMouseX;
      const dy = e.clientY - panDragRef.current.startMouseY;
      setViewport(prev => ({ ...prev, panX: panDragRef.current!.startPanX + dx, panY: panDragRef.current!.startPanY + dy }));
      return;
    }
    if (viewTab !== "mask") return;
    // Reverse the viewport transform to get canvas-pixel coords
    const outerRect = containerRef.current!.getBoundingClientRect();
    const cx = (e.clientX - outerRect.left - viewportRef.current.panX) / viewportRef.current.zoom;
    const cy = (e.clientY - outerRect.top  - viewportRef.current.panY) / viewportRef.current.zoom;

    // Always update brush cursor position for hover ring
    if (maskTool === 'brush_keep' || maskTool === 'brush_delete') {
      setBrushCanvasPos({ x: cx, y: cy });
    }

    if (isMaskBrushing && (maskTool === 'brush_keep' || maskTool === 'brush_delete')) {
      const imgPt = canvasToImage(cx, cy);
      if (imgPt) onMaskBrushPoint?.(imgPt.x, imgPt.y);
      return;
    }

    if (isLassoing && (maskTool === 'lasso_keep' || maskTool === 'lasso_delete')) {
      const last = lastLassoCanvasPoint.current;
      if (last) {
        const dx = cx - last.x, dy = cy - last.y;
        if (dx * dx + dy * dy < 25) return; // min 5px spacing
      }
      setLassoCanvasPoints(prev => [...prev, { x: cx, y: cy }]);
      lastLassoCanvasPoint.current = { x: cx, y: cy };
      // Clamp: always emit a point (clamped to image edge) so the polygon is never truncated.
      const lassoImgPt = canvasToImage(cx, cy, true);
      if (lassoImgPt) onMaskLassoPoint?.(lassoImgPt.x, lassoImgPt.y);
      return;
    }
  };

  const handleMaskPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || panDragRef.current) {
      panDragRef.current = null;
      setIsPanDragging(false);
      return;
    }
    if (viewTab !== "mask") return;
    if (isMaskBrushing) {
      setIsMaskBrushing(false);
      onMaskBrushEnd?.();
    }
    if (isLassoing) {
      setIsLassoing(false);
      setLassoCanvasPoints([]);
      lastLassoCanvasPoint.current = null;
      onMaskLassoClose?.();
    }
  };

  const handleMaskPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    setBrushCanvasPos(null);
    handleMaskPointerUp(e);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // If a text annotation is being edited, clicking the canvas confirms it and stops here.
    if (editingAnnotId) {
      confirmEdit();
      return;
    }
    // Middle mouse: start pan
    if (e.button === 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
      panDragRef.current = { startMouseX: e.clientX, startMouseY: e.clientY, startPanX: viewportRef.current.panX, startPanY: viewportRef.current.panY };
      setIsPanDragging(true);
      return;
    }
    // getBoundingClientRect on the canvas (inside the transform div) already accounts
    // for the CSS translate+scale, so x/y are correct canvas-pixel coords automatically.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (activeTool === "pen" || activeTool === "eraser") {
      e.currentTarget.setPointerCapture(e.pointerId);
      currentStrokeRef.current = [x, y];
      isDrawingRef.current = true;
      setIsDrawing(true);
      setSelectedStrokeId(null);
      setSelectedStrokeAnchor(null);
      startLiveStrokeLoop();
    } else if (activeTool === "select") {
      const hitId = hitTestStrokes(x, y);
      if (hitId) {
        const stroke = localStrokesRef.current.find(s => s.id === hitId);
        if (stroke) {
          const pts = stroke.points;
          const mid = Math.max(0, Math.floor(pts.length / 4) * 2);
          setSelectedStrokeAnchor({ x: pts[mid], y: pts[mid + 1] });
        }
        setSelectedStrokeId(hitId);
      } else {
        setSelectedStrokeId(null);
        setSelectedStrokeAnchor(null);
      }
    } else if (activeTool === "scale") {
      setScaleStart({ x, y }); setScaleEnd(null); isDrawingRef.current = true; setIsDrawing(true);
    } else if (activeTool === "region_fg" || activeTool === "region_bg" || activeTool === "region_support") {
      const kind = activeTool === "region_fg" ? "fg" : activeTool === "region_support" ? "support" : "bg";
      setRegionMarks(prev => [...prev, { x, y, kind }]);
    } else if (activeTool === "text") {
      startNewText(x, y);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (panDragRef.current) {
      const dx = e.clientX - panDragRef.current.startMouseX;
      const dy = e.clientY - panDragRef.current.startMouseY;
      setViewport(prev => ({ ...prev, panX: panDragRef.current!.startPanX + dx, panY: panDragRef.current!.startPanY + dy }));
      return;
    }
    if (!isDrawingRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (activeTool === "pen" || activeTool === "eraser") {
      // Pure ref mutation — no React re-render, RAF loop picks it up next frame
      currentStrokeRef.current.push(x, y);
    } else if (activeTool === "scale" && scaleStart) {
      setScaleEnd({ x, y });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || panDragRef.current) {
      panDragRef.current = null;
      setIsPanDragging(false);
      return;
    }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    setIsDrawing(false);
    if (activeTool === "pen" || activeTool === "eraser") {
      stopLiveStrokeLoop();
      const pts = currentStrokeRef.current;
      if (pts.length >= 2) {
        const newStroke: Stroke = {
          id: crypto.randomUUID(), points: [...pts],
          color: currentColor, width: currentWidth, tool: activeTool as StrokeTool,
        };
        // Use ref for the latest strokes array — avoids stale closure when
        // handlePointerUp fires before React re-renders with the newest state.
        const newStrokes = [...localStrokesRef.current, newStroke];
        setLocalStrokes(newStrokes);
        undoHistoryRef.current.push({ kind: "stroke", id: newStroke.id });
        saveAnnotations.mutate({ id: project.id, data: { projectId: project.id, strokes: newStrokes, textAnnotations: localTextAnnotationsRef.current } });
      }
      currentStrokeRef.current = [];
    } else if (activeTool === "scale" && scaleStart) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const dx = x - scaleStart.x, dy = y - scaleStart.y;
      const pixels = Math.round(Math.sqrt(dx * dx + dy * dy));
      setScaleEnd({ x, y });
      if (pixels > 10) onScaleMeasured?.({ pixels, x1: scaleStart.x, y1: scaleStart.y, x2: x, y2: y });
    }
  };

  // Place a new text annotation and immediately open it for editing
  const startNewText = (x: number, y: number) => {
    const id = crypto.randomUUID();
    const newAnnot: TextAnnotation = { id, x, y, text: "", color: currentColor, fontSize: 14, kind: "text" };
    const updated = [...localTextAnnotationsRef.current, newAnnot];
    setLocalTextAnnotations(updated);
    setEditingAnnotId(id);
    setEditingAnnotValue("");
    editingIsNewRef.current = true;
    setTimeout(() => editInputRef.current?.focus(), 30);
  };

  // Open an existing annotation for editing
  const openEditText = (t: TextAnnotation) => {
    setEditingAnnotId(t.id);
    setEditingAnnotValue(t.text);
    editingIsNewRef.current = false;
    setTimeout(() => editInputRef.current?.focus(), 30);
  };

  // Confirm the current edit/new — only called via Enter or ✓ button, never onBlur
  const confirmEdit = () => {
    if (!editingAnnotId) return;
    const trimmed = editingAnnotValue.trim();
    let updated: TextAnnotation[];
    if (!trimmed) {
      // Empty → discard the annotation
      updated = localTextAnnotationsRef.current.filter(a => a.id !== editingAnnotId);
    } else {
      updated = localTextAnnotationsRef.current.map(a =>
        a.id === editingAnnotId ? { ...a, text: trimmed } : a
      );
      if (editingIsNewRef.current) {
        undoHistoryRef.current.push({ kind: "annotation", id: editingAnnotId });
      }
    }
    setLocalTextAnnotations(updated);
    saveAnnotations.mutate({ id: project.id, data: { projectId: project.id, strokes: localStrokesRef.current, textAnnotations: updated } });
    setEditingAnnotId(null);
    editingIsNewRef.current = false;
  };

  // Cancel — if new and uncommitted, remove the placeholder; if editing existing, discard changes
  const cancelEdit = () => {
    if (!editingAnnotId) return;
    if (editingIsNewRef.current) {
      const updated = localTextAnnotationsRef.current.filter(a => a.id !== editingAnnotId);
      setLocalTextAnnotations(updated);
      saveAnnotations.mutate({ id: project.id, data: { projectId: project.id, strokes: localStrokesRef.current, textAnnotations: updated } });
    }
    setEditingAnnotId(null);
    editingIsNewRef.current = false;
  };

  // Delete text
  const deleteText = (id: string) => {
    const toDelete = localTextAnnotations.find(t => t.id === id);
    const updated = localTextAnnotations.filter(t => t.id !== id);
    setLocalTextAnnotations(updated);
    saveAnnotations.mutate({ id: project.id, data: { projectId: project.id, strokes: localStrokes, textAnnotations: updated } });
    if (toDelete?.kind === "scale") {
      onScaleAnnotationUndone?.();
      setScaleStart(null);
      setScaleEnd(null);
    }
  };

  // Pen/eraser drawing only work in "修正後" tab or pre-image mode.
  const canDraw = (viewTab === null || viewTab === "corrected") &&
    (activeTool === "pen" || activeTool === "eraser");

  // Text, B/F/S region marks and scale measurement work in ALL tabs.
  const canMarkOrMeasure =
    activeTool === "text" || activeTool === "region_fg" || activeTool === "region_bg" || activeTool === "region_support" || activeTool === "scale";

  // Text annotations are always interactive and visible across all tabs.
  const canInteractText = true;

  // Zoom controls helpers
  const zoomIn    = () => setViewport(p => ({ ...p, zoom: Math.min(8,    p.zoom * 1.25) }));
  const zoomOut   = () => setViewport(p => ({ ...p, zoom: Math.max(0.25, p.zoom / 1.25) }));
  const zoomReset = () => setViewport({ zoom: 1.0, panX: 0, panY: 0 });

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-accent/20 overflow-hidden"
      style={{ cursor: cursorStyle }}
      onPointerDown={handleMaskPointerDown}
      onPointerMove={handleMaskPointerMove}
      onPointerUp={handleMaskPointerUp}
      onPointerLeave={handleMaskPointerLeave}
    >
      {/* Dot grid — aesthetic only, stays outside transform */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{ backgroundImage: "radial-gradient(#fff 1px, transparent 0)", backgroundSize: "20px 20px" }}
      />

      {/* View mode label — step indicator for read-only pipeline tabs */}
      {(viewTab === "original" || viewTab === "step2" || viewTab === "step3" || viewTab === "step4" || viewTab === "lineart" || viewTab === "mask") && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-background/80 border border-border rounded text-[10px] font-mono text-muted-foreground pointer-events-none z-20">
          {viewTab === "original" && "元の写真（入力）"}
          {viewTab === "mask"     && "Stage 1 — 対象抽出プレビュー"}
          {viewTab === "step2"    && "Stage 1 — 投げ縄選択"}
          {viewTab === "step3"    && "Stage 2 — 特徴線強調"}
          {viewTab === "step4"    && "Stage 3 — エッジ抽出"}
          {viewTab === "lineart"  && "線画"}
        </div>
      )}

      {/* Mask tool hint banner */}
      {viewTab === "mask" && (
        <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded text-[10px] font-mono font-bold pointer-events-none z-20 ${
          maskTool === 'brush_keep' || maskTool === 'seed_fg'
            ? "bg-green-900/80 text-green-300 border border-green-600"
            : maskTool === 'seed_support'
              ? "bg-orange-900/80 text-orange-300 border border-orange-600"
              : maskTool === 'flood_delete'
                ? "bg-blue-900/80 text-blue-300 border border-blue-600"
                : maskTool === 'flood_keep'
                  ? "bg-green-900/80 text-green-300 border border-green-600"
                  : maskTool === 'lasso_keep'
                  ? "bg-green-900/80 text-green-200 border border-green-500"
                  : "bg-red-900/80 text-red-300 border border-red-600"
        }`}>
          {maskTool === 'seed_fg'      && "✓ シード — 研究対象をクリック"}
          {maskTool === 'seed_support' && "S シード — 撮影台・台紙・固定具をクリック"}
          {maskTool === 'seed_bg'      && "✕ シード — 背景をクリック"}
          {maskTool === 'brush_keep'   && "✓ 保持ブラシ — ドラッグで塗って保持"}
          {maskTool === 'brush_delete' && "✕ 削除ブラシ — ドラッグで塗って削除"}
          {maskTool === 'flood_delete' && "🎯 物体削除 — クリックで接触物体を一括削除"}
          {maskTool === 'flood_keep'   && "✅ 物体保持 — クリックで接触領域を一括保持"}
          {maskTool === 'lasso_keep'   && "↖ 投げ縄・保持 — ドラッグで囲む"}
          {maskTool === 'lasso_delete' && "↖ 投げ縄・削除 — ドラッグで囲む"}
        </div>
      )}

      {/* ── Inner transform layer (pan + zoom) ─────────────────────────────────
           All canvas content lives here so that a single CSS transform moves
           everything together. getBoundingClientRect() on child canvases
           naturally accounts for translate+scale, so coordinate conversions
           in event handlers require no extra correction.                        */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        {/* Layer 1: original photo / intermediate step / mask preview / correction BG (greyscale 部位マップ) */}
        <canvas
          ref={baseCanvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="absolute inset-0 pointer-events-none transition-opacity"
          style={{
            opacity: viewTab === "original" || viewTab === "step2" || viewTab === "step3" || viewTab === "step4" || viewTab === "mask"
              ? 1
              : viewTab === "corrected"
                ? 1
                : viewTab === null
                  ? 1
                  : 0,
            zIndex: 1,
          }}
        />

        {/* Layer 2: line art (shown in null-tab only; hidden in corrected/手書き修正 tab) */}
        <canvas
          ref={lineartCanvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="absolute inset-0 pointer-events-none transition-opacity"
          style={{
            opacity: viewTab === "lineart"
              ? 1
              : viewTab === "corrected"
                ? 0   // 手書き修正 tab: lineart hidden — 部位マップ (Layer 1) is the reference
                : viewTab === null
                  ? 1
                  : 0,
            zIndex: 2,
          }}
        />

        {/* Layer 3: annotation / drawing
            Drawing strokes visible in: null / "修正後" tabs only.
            B/F region marks and scale measurement work in ALL tabs. */}
        <canvas
          ref={annotationCanvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="absolute inset-0 touch-none"
          style={{
            opacity: viewTab === "corrected"
              ? (correctionDraftVisible ? 1 : 0)
              : viewTab === null ? 1 : 0,
            zIndex: 3,
            pointerEvents: (canDraw || canMarkOrMeasure) ? "auto" : "none",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />

        {/* Layer 3b: live stroke — in-progress pen/eraser preview (RAF-driven, no React re-render) */}
        <canvas
          ref={liveStrokeCanvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="absolute inset-0 pointer-events-none"
          style={{ zIndex: 4 }}
        />

        {/* Overlay: scale line + region marks + brush cursor + lasso */}
        <canvas
          ref={overlayCanvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="absolute inset-0 pointer-events-none"
          style={{ zIndex: 5 }}
        />

        {/* Scale annotations — rendered as a measurement line + label */}
        {localTextAnnotations.filter(t => t.kind === "scale").map(sa => {
          const x1 = sa.x, y1 = sa.y, x2 = sa.x2 ?? sa.x, y2 = sa.y2 ?? sa.y;
          const dx = x2 - x1, dy = y2 - y1;
          const length = Math.sqrt(dx * dx + dy * dy);
          const angle = Math.atan2(dy, dx) * 180 / Math.PI;
          const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
          const lineColor = viewTab === "corrected" ? "#111111" : "#ffffff";
          const labelBg   = viewTab === "corrected" ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.70)";
          const labelColor = viewTab === "corrected" ? "#111111" : "#ffffff";
          const boxInteractive = canInteractText && activeTool !== "pen" && activeTool !== "eraser";
          return (
            <div
              key={sa.id}
              className="absolute"
              style={{ left: 0, top: 0, pointerEvents: "none", zIndex: 7 }}
            >
              {/* Measurement line */}
              <div
                className="absolute"
                style={{
                  left: x1, top: y1 - 1,
                  width: length, height: 2,
                  transformOrigin: "0 50%",
                  transform: `rotate(${angle}deg)`,
                  backgroundColor: lineColor,
                }}
              />
              {/* Start tick */}
              <div
                className="absolute"
                style={{
                  left: x1 - 1, top: y1 - 5,
                  width: 2, height: 10,
                  backgroundColor: lineColor,
                }}
              />
              {/* End tick */}
              <div
                className="absolute"
                style={{
                  left: x2 - 1, top: y2 - 5,
                  width: 2, height: 10,
                  backgroundColor: lineColor,
                }}
              />
              {/* Label */}
              <div
                className="absolute px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold whitespace-nowrap"
                style={{
                  left: midX, top: midY - 20,
                  transform: "translateX(-50%)",
                  background: labelBg,
                  color: labelColor,
                }}
              >
                {sa.text}
              </div>
              {/* Delete button */}
              {boxInteractive && (
                <button
                  className="absolute pointer-events-auto text-destructive hover:text-destructive/70 bg-background/80 rounded"
                  style={{ left: x2 + 6, top: y2 - 10, zIndex: 8 }}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={() => deleteText(sa.id)}
                  title="削除"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        {/* Text annotations — Word-style: text only, no border/box in normal mode.
            Edit: thin dashed outline, blur or Enter to confirm.
            Normal: text only, hover shows edit/delete icons, drag to move. */}
        {localTextAnnotations.filter(t => t.kind !== "scale").map(t => {
          const isEditing  = editingAnnotId === t.id;
          const isDragging = draggingText?.id === t.id;
          const boxInteractive = canInteractText && activeTool !== "pen" && activeTool !== "eraser";
          return (
            <div
              key={t.id}
              className="absolute group"
              style={{
                left: t.x,
                top:  t.y,
                zIndex: isEditing || isDragging ? 20 : 6,
                userSelect: "none",
                pointerEvents: boxInteractive ? "auto" : "none",
                cursor: isDragging ? "grabbing" : boxInteractive ? "grab" : "default",
              }}
              onPointerDown={e => {
                if (!boxInteractive || isEditing) return;
                e.stopPropagation();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setDraggingText({
                  id: t.id,
                  startClientX: e.clientX, startClientY: e.clientY,
                  origX: t.x, origY: t.y,
                  startZoom: viewportRef.current.zoom,
                  moved: false,
                });
              }}
              onPointerMove={e => {
                if (!draggingText || draggingText.id !== t.id) return;
                const dx = (e.clientX - draggingText.startClientX) / draggingText.startZoom;
                const dy = (e.clientY - draggingText.startClientY) / draggingText.startZoom;
                if (!draggingText.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                  setDraggingText(d => d ? { ...d, moved: true } : null);
                }
                if (draggingText.moved) {
                  setLocalTextAnnotations(prev =>
                    prev.map(a => a.id === t.id ? { ...a, x: draggingText.origX + dx, y: draggingText.origY + dy } : a)
                  );
                }
              }}
              onPointerUp={e => {
                if (!draggingText || draggingText.id !== t.id) return;
                const wasMoved = draggingText.moved;
                const dx = (e.clientX - draggingText.startClientX) / draggingText.startZoom;
                const dy = (e.clientY - draggingText.startClientY) / draggingText.startZoom;
                setDraggingText(null);
                if (!wasMoved) {
                  openEditText(t);
                } else {
                  const finalX = draggingText.origX + dx;
                  const finalY = draggingText.origY + dy;
                  const updated = localTextAnnotationsRef.current.map(a =>
                    a.id === t.id ? { ...a, x: finalX, y: finalY } : a
                  );
                  setLocalTextAnnotations(updated);
                  saveAnnotations.mutate({
                    id: project.id,
                    data: { projectId: project.id, strokes: localStrokesRef.current, textAnnotations: updated },
                  });
                }
              }}
              onPointerLeave={e => {
                if (!draggingText || draggingText.id !== t.id) return;
                if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) setDraggingText(null);
              }}
            >
              {isEditing ? (
                /* ── Edit mode: thin dashed outline, no buttons ─────────────── */
                <div
                  style={{
                    outline: "1.5px dashed rgba(99,102,241,0.7)",
                    outlineOffset: "3px",
                    borderRadius: 2,
                  }}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <input
                    ref={editInputRef}
                    className="block bg-transparent outline-none font-mono leading-snug min-w-[60px]"
                    style={{ color: t.color || currentColor, fontSize: t.fontSize ?? 14 }}
                    value={editingAnnotValue}
                    size={Math.max(editingAnnotValue.length + 1, 6)}
                    onChange={e => setEditingAnnotValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); confirmEdit(); }
                      if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                    }}
                    placeholder="テキスト…"
                    autoFocus
                  />
                </div>
              ) : (
                /* ── Normal mode: text only, icons on hover ──────────────────── */
                <div className="flex items-center gap-1">
                  <span
                    className="font-mono whitespace-pre leading-snug"
                    style={{ color: t.color, fontSize: t.fontSize ?? 14 }}
                  >
                    {t.text}
                  </span>
                  {boxInteractive && !isDragging && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        className="text-white/60 hover:text-white p-0.5 rounded"
                        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); openEditText(t); }}
                        title="編集"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        className="text-white/60 hover:text-red-400 p-0.5 rounded"
                        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); deleteText(t.id); }}
                        title="削除"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* ── End inner transform layer ──────────────────────────────────────── */}

      {/* Floating delete button for selected stroke — outside transform, positioned in screen-space */}
      {selectedStrokeId && selectedStrokeAnchor && (
        <div
          className="absolute z-40 pointer-events-auto"
          style={{
            left: selectedStrokeAnchor.x * viewport.zoom + viewport.panX,
            top:  selectedStrokeAnchor.y * viewport.zoom + viewport.panY - 32,
          }}
        >
          <div className="flex items-center gap-1 bg-background border border-amber-500 rounded shadow-lg px-1.5 py-0.5">
            <span className="text-[9px] font-mono text-amber-400">線を選択中</span>
            <button
              className="text-[9px] font-mono text-destructive hover:text-destructive/70 transition-colors px-1.5 py-0.5 rounded hover:bg-destructive/10"
              onClick={() => {
                const updated = localStrokesRef.current.filter(s => s.id !== selectedStrokeId);
                setLocalStrokes(updated);
                saveAnnotations.mutate({ id: project.id, data: { projectId: project.id, strokes: updated, textAnnotations: localTextAnnotationsRef.current } });
                setSelectedStrokeId(null);
                setSelectedStrokeAnchor(null);
              }}
            >
              🗑 削除
            </button>
            <button
              className="text-[9px] font-mono text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5 rounded hover:bg-muted"
              onClick={() => { setSelectedStrokeId(null); setSelectedStrokeAnchor(null); }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Scale bar — outside transform so its physical size stays constant.
          In the corrected tab the background is white, so use black; otherwise use white. */}
      {project.scalePixels && project.scaleValue && project.scaleUnit && (
        <div className="absolute bottom-6 left-6 pointer-events-none flex flex-col items-center z-50">
          {viewTab === "corrected" ? (
            <>
              <div className="text-xs font-mono font-medium text-black drop-shadow-[0_1px_2px_rgba(255,255,255,0.9)]">
                {project.scaleValue} {project.scaleUnit}
              </div>
              <div className="h-[2px] bg-black border-x-2 border-black" style={{ width: `${project.scalePixels}px` }} />
            </>
          ) : (
            <>
              <div className="text-xs font-mono font-medium drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] text-white">
                {project.scaleValue} {project.scaleUnit}
              </div>
              <div className="h-1 bg-white border-x-2 border-white" style={{ width: `${project.scalePixels}px` }} />
            </>
          )}
        </div>
      )}

      {/* Tool hint */}
      {(viewTab === null || viewTab === "corrected") && (activeTool === "scale" || activeTool === "region_fg" || activeTool === "region_bg" || activeTool === "region_support") && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-background/80 border border-border text-[10px] font-mono text-muted-foreground pointer-events-none z-20">
          {activeTool === "scale"          && "ドラッグして計測距離を指定 → 実寸を入力"}
          {activeTool === "region_fg"      && "研究対象としてマーク — 緑●"}
          {activeTool === "region_bg"      && "背景としてマーク — 赤●"}
          {activeTool === "region_support" && "支持体としてマーク — 橙●"}
        </div>
      )}

      {/* Zoom controls — always anchored to bottom-right corner */}
      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 bg-black/65 rounded px-1.5 py-0.5 text-[9px] font-mono text-white/90 z-30 select-none pointer-events-auto">
        <button onClick={zoomOut}   className="w-4 h-4 flex items-center justify-center hover:text-yellow-300 transition-colors" title="縮小 (ホイール下)">−</button>
        <span   onClick={zoomReset} className="w-9 text-center cursor-pointer hover:text-yellow-300 transition-colors"            title="リセット">{Math.round(viewport.zoom * 100)}%</span>
        <button onClick={zoomIn}    className="w-4 h-4 flex items-center justify-center hover:text-yellow-300 transition-colors" title="拡大 (ホイール上)">+</button>
        <span className="mx-0.5 text-white/30">|</span>
        <button onClick={zoomReset} className="px-0.5 hover:text-yellow-300 transition-colors" title="表示リセット">⌂</button>
      </div>

      {/* Pan hint — shown only when zoomed */}
      {viewport.zoom !== 1.0 && (
        <div className="absolute top-10 left-1/2 -translate-x-1/2 text-[8px] font-mono text-white/50 bg-black/40 rounded px-1.5 py-0.5 pointer-events-none z-20">
          中クリックドラッグ でパン
        </div>
      )}
    </div>
  );
}
