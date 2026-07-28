import {
  useGetProject, useGetAnnotations,
  useUpdateProject,
  getGetProjectQueryKey, getGetAnnotationsQueryKey,
} from "@/lib/use-projects";
import {
  runPipeline, advanceStage,
  fetchPipelineTree, fetchNodeImage,
  b64ToDataUrl, checkSidecarAvailable,
  type StageType, type PipelineMode, type PipelineNode, type PipelineTree,
} from "@/lib/pipeline-api";
import { LassoEditor, type LassoStroke } from "@/components/editor/lasso-editor";
import { type TextAnnotation } from "@/components/editor/canvas-workspace";
import { useParams, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { CanvasWorkspace } from "@/components/editor/canvas-workspace";
import { Button } from "@/components/ui/button";
import {
  Loader2, ArrowLeft, Download, MousePointer2, Pen, Eraser, Type,
  Ruler, ImagePlus, Camera, FolderOpen, Undo2, Trash2,
  CheckCircle2, ChevronRight, PanelRightClose, PanelRightOpen,
  AlertTriangle,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useState, useRef, useCallback, useEffect } from "react";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

type Tool = "select" | "pen" | "eraser" | "text" | "scale" | "region_fg" | "region_bg" | "region_support";
/** Canvas view tabs — reuses CanvasWorkspace's intermediate-image tabs:
 *   step2     → Stage 1 範囲選択 (stage1_selected)
 *   step3     → Stage 2 特徴線強調 (feature_removed)
 *   step4     → Stage 3 エッジ抽出 (edge_extracted)
 *   structure → Stage 4 線の整理 (lines_organized)
 *   stage5    → Stage 5 線構造解析 (structure_extracted)
 */
type ViewTab = "original" | "step2" | "step3" | "step4" | "corrected" | null;

const MODE_LABEL: Record<PipelineMode, string> = {
  insect:   "昆虫",
  plant:    "植物",
  fossil:   "化石",
  artifact: "考古遺物",
  general:  "汎用",
};

/** Map a project preset string to a PipelineMode (fallback: general). */
function presetToMode(preset: string | null | undefined): PipelineMode {
  switch (preset) {
    case "insect": case "plant": case "fossil": case "artifact":
      return preset;
    default:
      return "general";
  }
}

/** Strip the data-URL prefix so the raw base64 payload can be sent to the API. */
function dataUrlToB64(dataUrl: string): string {
  const idx = dataUrl.indexOf("base64,");
  return idx >= 0 ? dataUrl.slice(idx + "base64,".length) : dataUrl;
}

/** Return the most recently created node of a given stage type (last in insertion order). */
function latestNodeOfStage(tree: PipelineTree, stage: StageType): PipelineNode | null {
  let found: PipelineNode | null = null;
  for (const node of Object.values(tree.nodes)) {
    if (node.stage_type === stage) found = node;
  }
  return found;
}

export default function Editor() {
  const params = useParams();
  const id = parseInt(params.id ?? "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: project, isLoading } = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) },
  });
  const { data: annotations } = useGetAnnotations(id, { query: { enabled: !!id, queryKey: getGetAnnotationsQueryKey(id) } });

  const updateProject = useUpdateProject();

  // ── Tool ──
  const [activeTool, setActiveTool]     = useState<Tool>("pen");
  const [currentColor, setCurrentColor] = useState("#000000");
  const [currentWidth, setCurrentWidth] = useState(2);
  const [undoTrigger, setUndoTrigger]   = useState(0);
  const [showRightPanel, setShowRightPanel] = useState(true);

  // ── Lasso selection (Stage 1) ──
  const [lassoMode,    setLassoMode]    = useState(false);
  const [lassoKind,    setLassoKind]    = useState<"include" | "exclude">("include");
  const [lassoStrokes, setLassoStrokes] = useState<LassoStroke[]>([]);
  const [imageDimensions, setImageDimensions] = useState<{ w: number; h: number } | null>(null);

  // ── Pipeline state (stage-based API) ──
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>("general");
  const [sidecarOk, setSidecarOk]       = useState<boolean | null>(null);
  const [pipelineTree, setPipelineTree] = useState<PipelineTree | null>(null);
  /** Node id per stage (latest run) */
  const [stageNodeIds, setStageNodeIds] = useState<Partial<Record<StageType, string>>>({});
  /** Data URL of each stage's output image */
  const [stageImages, setStageImages]   = useState<Partial<Record<StageType, string>>>({});
  /** Which stage is currently running (1 = stages 0–2, 3, 4, 5) */
  const [runningStage, setRunningStage] = useState<number | null>(null);
  /** 手書き修正タブの参照背景ステージ選択 */
  const [corrBgKey, setCorrBgKey] = useState<"original" | StageType>("edge_extracted");
  /** 手書き修正: 背景レイヤの表示/非表示 */
  const [corrBgVisible, setCorrBgVisible] = useState(true);
  /** 手書き修正: 前景 canvas (下書き+ストローク) の表示/非表示 */
  const [corrDraftVisible, setCorrDraftVisible] = useState(true);
  /** 手書き修正: インクリメントで canvas を Stage 6 下書き状態にリセット */
  const [corrResetKey, setCorrResetKey] = useState(0);

  // Initialise pipeline mode from the project preset once loaded
  useEffect(() => {
    if (project?.preset) setPipelineMode(presetToMode(project.preset));
  }, [project?.preset]);

  // Check sidecar availability on mount
  useEffect(() => {
    let cancelled = false;
    checkSidecarAvailable().then(ok => { if (!cancelled) setSidecarOk(ok); });
    return () => { cancelled = true; };
  }, []);

  /** Refresh the pipeline tree and derive the latest node id + image per stage. */
  const refreshPipelineState = useCallback(async () => {
    const tree = await fetchPipelineTree(id);
    setPipelineTree(tree);

    const stages: StageType[] = [
      "original", "stage1_selected", "feature_removed", "edge_extracted",
    ];
    const nodeIds: Partial<Record<StageType, string>> = {};
    for (const stage of stages) {
      const node = latestNodeOfStage(tree, stage);
      if (node) nodeIds[stage] = node.id;
    }
    setStageNodeIds(nodeIds);

    // Fetch stage output images (skip original — project.imageUrl is shown instead)
    const imageStages = stages.filter(s => s !== "original" && nodeIds[s]);
    const entries = await Promise.all(imageStages.map(async stage => {
      try {
        const res = await fetchNodeImage(id, nodeIds[stage]!);
        return [stage, b64ToDataUrl(res.image_b64)] as const;
      } catch {
        return [stage, undefined] as const;
      }
    }));
    setStageImages(prev => {
      const next = { ...prev };
      for (const [stage, url] of entries) {
        if (url) next[stage] = url;
      }
      return next;
    });

    return tree;
  }, [id]);

  // Load natural image dimensions for lasso coordinate conversion
  useEffect(() => {
    if (!project?.imageUrl) { setImageDimensions(null); return; }
    const img = new Image();
    img.onload = () => setImageDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = project.imageUrl;
  }, [project?.imageUrl]);

  // Restore an existing pipeline tree when the project loads
  useEffect(() => {
    if (!project?.imageUrl) return;
    refreshPipelineState().catch(() => { /* no tree yet — ignore */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.imageUrl]);

  const resetPipelineState = useCallback(() => {
    setPipelineTree(null);
    setStageNodeIds({});
    setStageImages({});
    setRunningStage(null);
  }, []);

  // ── View tab ──
  const [viewTab, setViewTab] = useState<ViewTab>(null);

  useEffect(() => {
    if (!project?.imageUrl || viewTab !== null) return;
    setViewTab(project.lineArtUrl ? "corrected" : "original");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.imageUrl, project?.lineArtUrl]);

  // ── Scale ──
  const [scalePending, setScalePending] = useState<{ pixels: number; x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [scaleValue, setScaleValue]     = useState("1");
  const [scaleUnit, setScaleUnit]       = useState("mm");

  /** AI/scale labels queued for merging into the canvas annotation layer */
  const [pendingAIAnnotations, setPendingAIAnnotations] = useState<TextAnnotation[]>([]);

  // ── Camera / file ──
  const [isDragging, setIsDragging]     = useState(false);
  const [showCamera, setShowCamera]     = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const videoRef     = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { cameraStream?.getTracks().forEach(t => t.stop()); }, [cameraStream]);

  const loadImageData = useCallback((base64: string) => {
    updateProject.mutate(
      { id, data: { imageUrl: base64, lineArtUrl: "", lineArtSvg: "", status: "has_image" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
          resetPipelineState();
          setLassoStrokes([]);
          setLassoMode(false);
          setViewTab("original");
          toast({ title: "画像を読み込みました" });
        },
        onError: () => toast({ title: "読み込みエラー", variant: "destructive" }),
      }
    );
  }, [id, updateProject, queryClient, toast, resetPipelineState]);

  const handleFile = (file: File) => {
    if (file.type.startsWith("video/")) {
      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.src = url; vid.currentTime = 0.5;
      vid.onloadeddata = () => {
        const c = document.createElement("canvas");
        c.width = vid.videoWidth; c.height = vid.videoHeight;
        c.getContext("2d")?.drawImage(vid, 0, 0);
        URL.revokeObjectURL(url);
        loadImageData(c.toDataURL("image/jpeg", 0.92));
      };
    } else {
      const reader = new FileReader();
      reader.onload = e => loadImageData(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      setCameraStream(stream); setShowCamera(true);
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
    } catch { toast({ title: "カメラエラー", variant: "destructive" }); }
  };
  const shootCamera = () => {
    if (!videoRef.current) return;
    const c = document.createElement("canvas");
    c.width = videoRef.current.videoWidth; c.height = videoRef.current.videoHeight;
    c.getContext("2d")?.drawImage(videoRef.current, 0, 0);
    cameraStream?.getTracks().forEach(t => t.stop());
    setCameraStream(null); setShowCamera(false);
    loadImageData(c.toDataURL("image/jpeg", 0.92));
  };
  const closeCamera = () => {
    cameraStream?.getTracks().forEach(t => t.stop());
    setCameraStream(null); setShowCamera(false);
  };

  const handleDeletePhoto = async () => {
    await updateProject.mutateAsync({ id, data: { imageUrl: "", lineArtUrl: "", lineArtSvg: "", status: "empty" } });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
    resetPipelineState();
    setLassoStrokes([]);
    setLassoMode(false);
    setViewTab(null);
    toast({ title: "写真を削除しました" });
  };

  const confirmScale = async () => {
    if (scalePending === null) return;
    const val = parseFloat(scaleValue);
    if (isNaN(val) || val <= 0) return;
    await updateProject.mutateAsync({ id, data: { scalePixels: scalePending.pixels, scaleValue: val, scaleUnit } });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
    const scaleAnn: TextAnnotation = {
      id: crypto.randomUUID(),
      x: scalePending.x1,
      y: scalePending.y1,
      x2: scalePending.x2,
      y2: scalePending.y2,
      text: `${val} ${scaleUnit}`,
      fontSize: 12,
      color: "#111111",
      kind: "scale",
    };
    setPendingAIAnnotations([scaleAnn]);
    setScalePending(null);
    toast({ title: `スケール設定：${scalePending.pixels}px = ${val} ${scaleUnit}` });
  };

  // ── Pipeline stage handlers ────────────────────────────────────────────────

  /** Stages 1–2: 投げ縄選択 → 特徴線強調（/pipeline/run で同時実行） */
  const handleRunStages12 = async () => {
    if (!project?.imageUrl || runningStage !== null) return;
    setLassoMode(false);
    setRunningStage(1);
    const includePolygons = lassoStrokes.filter(s => s.kind === "include").map(s => s.points);
    const excludePolygons = lassoStrokes.filter(s => s.kind === "exclude").map(s => s.points);
    try {
      await runPipeline(id, dataUrlToB64(project.imageUrl), pipelineMode, {
        includePolygons: includePolygons.length > 0 ? includePolygons : undefined,
        excludePolygons: excludePolygons.length > 0 ? excludePolygons : undefined,
      });
      await refreshPipelineState();
      setViewTab("step2");
      toast({ title: "投げ縄選択・特徴線強調が完了しました" });
    } catch (e) {
      toast({ title: "パイプライン実行エラー", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setRunningStage(null);
    }
  };

  /** Stage 3: feature_removed → edge_extracted */
  const handleAdvanceEdge = async () => {
    const fromId = stageNodeIds.feature_removed;
    if (!fromId || runningStage !== null) return;
    setRunningStage(3);
    try {
      await advanceStage(id, fromId, pipelineMode);
      await refreshPipelineState();
      setViewTab("step4");
      toast({ title: "エッジ抽出が完了しました" });
    } catch (e) {
      toast({ title: "エッジ抽出エラー", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setRunningStage(null);
    }
  };

  /** 手書き修正 初期化: ユーザーストロークと undo 履歴をクリアする。 */
  const handleCorrectionReset = () => {
    setCorrResetKey(k => k + 1);
  };

  // ── Derived view data ──────────────────────────────────────────────────────

  const intermediateImageUrl =
    viewTab === "step2" ? stageImages.stage1_selected :
    viewTab === "step3" ? stageImages.feature_removed :
    viewTab === "step4" ? stageImages.edge_extracted :
    undefined;

  /** 手書き修正タブの参照背景 URL (ステージ選択 or 元画像) */
  const activeCorrBgUrl: string | undefined =
    corrBgKey === "original"
      ? (project?.imageUrl ?? undefined)
      : (stageImages[corrBgKey] ?? undefined);

  /** 背景セレクタのオプション定義 */
  const corrBgOptions: Array<{ key: "original" | StageType; label: string; url: string | undefined }> = [
    { key: "original",        label: "元画像",  url: project?.imageUrl ?? undefined },
    { key: "stage1_selected", label: "1 選択",  url: stageImages.stage1_selected },
    { key: "feature_removed", label: "2 特徴線", url: stageImages.feature_removed },
    { key: "edge_extracted",  label: "3 エッジ", url: stageImages.edge_extracted },
  ];

  const availableTabs = [
    { key: "original"  as const, label: "元写真",     step: null, available: !!project?.imageUrl },
    { key: "step2"     as const, label: "投げ縄選択", step: 1,    available: !!stageImages.stage1_selected },
    { key: "step3"     as const, label: "特徴線強調", step: 2,    available: !!stageImages.feature_removed },
    { key: "step4"     as const, label: "エッジ抽出", step: 3,    available: !!stageImages.edge_extracted },
    { key: "corrected" as const, label: "手書き修正", step: 4,    available: !!(stageImages.edge_extracted ?? project?.lineArtUrl) },
  ].filter(t => t.available);

  const nodeCount = pipelineTree ? Object.keys(pipelineTree.nodes).length : 0;

  if (isLoading) return (
    <Layout>
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    </Layout>
  );

  if (!project) return (
    <Layout>
      <div className="flex h-full items-center justify-center flex-col gap-4">
        <h2 className="font-mono text-xl">Workspace Not Found</h2>
        <Button onClick={() => setLocation("/")} variant="outline" className="font-mono">
          <ArrowLeft className="w-4 h-4 mr-2" /> 一覧に戻る
        </Button>
      </div>
    </Layout>
  );

  return (
    <Layout>
      <div className="flex flex-col h-full bg-background overflow-hidden">

        {/* ── Header ── */}
        <header className="h-14 border-b border-border flex items-center justify-between px-4 shrink-0 bg-card">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setLocation("/")} className="text-muted-foreground">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="font-mono text-sm font-semibold">{project.name}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] font-mono uppercase text-muted-foreground">{project.preset}</span>
                <span className="w-1 h-1 rounded-full bg-border" />
                <span className="text-[10px] font-mono uppercase text-muted-foreground">
                  {project.status?.replace("_", " ")}
                </span>
                {project.lineArtSvg && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-border" />
                    <span className="text-[10px] font-mono text-green-500">SVG ready</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input ref={fileInputRef} type="file" className="hidden" accept="image/*,video/*"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />

            <Button size="sm" variant="outline" className="text-xs h-8"
              onClick={() => fileInputRef.current?.click()}>
              <FolderOpen className="w-3.5 h-3.5 mr-2" /> 写真を開く
            </Button>
            <Button size="sm" variant="outline" className="text-xs h-8" onClick={startCamera}>
              <Camera className="w-3.5 h-3.5 mr-2" /> カメラ
            </Button>
            {project.imageUrl && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline"
                    className="font-mono text-xs h-8 text-destructive hover:text-destructive border-destructive/40">
                    <Trash2 className="w-3.5 h-3.5 mr-2" /> 写真を削除
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-mono">写真を削除しますか？</AlertDialogTitle>
                    <AlertDialogDescription className="font-mono text-xs">
                      元写真・線画・SVGデータが削除されます。この操作は取り消せません。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="font-mono text-xs">キャンセル</AlertDialogCancel>
                    <AlertDialogAction
                      className="font-mono text-xs bg-destructive hover:bg-destructive/90"
                      onClick={handleDeletePhoto}>削除する</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Separator orientation="vertical" className="h-6" />
            <Button size="sm" variant="ghost"
              onClick={() => setShowRightPanel(v => !v)}
              className="text-muted-foreground h-8 w-8 px-0 hidden lg:flex">
              {showRightPanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
            </Button>
            <Button size="sm" variant="outline" className="text-xs h-8"
              onClick={() => setLocation(`/project/${project.id}/export`)}>
              <Download className="w-3.5 h-3.5 mr-2" /> エクスポート
            </Button>
          </div>
        </header>

        {/* ── Main ── */}
        <div className="flex-1 flex overflow-hidden">

          {/* Left toolbar */}
          <div className="w-16 border-r border-border bg-sidebar flex flex-col items-center py-3 gap-1 shrink-0 z-10">
            <TB icon={<MousePointer2 />} label="選択"     active={activeTool === "select"} onClick={() => setActiveTool("select")} />
            <TB icon={<Pen />}           label="ペン"     active={activeTool === "pen"}    onClick={() => setActiveTool("pen")} />
            <TB icon={<Eraser />}        label="消しゴム" active={activeTool === "eraser"} onClick={() => setActiveTool("eraser")} />
            <TB icon={<Type />}          label="テキスト" active={activeTool === "text"}   onClick={() => setActiveTool("text")} />
            <Separator className="w-8 my-1" />
            <TB icon={<Ruler />} label="スケール" active={activeTool === "scale"} onClick={() => setActiveTool("scale")} />
            <Separator className="w-8 my-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon"
                  className="w-10 h-10 rounded-lg text-muted-foreground hover:text-foreground"
                  onClick={() => setUndoTrigger(n => n + 1)}>
                  <Undo2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="font-mono text-xs">一つ戻る</TooltipContent>
            </Tooltip>

            <div className="mt-auto flex flex-col items-center gap-3 w-full px-2 pb-2">
              <div className="w-full">
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-[9px] uppercase font-mono text-muted-foreground">太さ</Label>
                  <span className="text-[9px] font-mono text-muted-foreground">
                    {project.scalePixels && project.scaleValue
                      ? `${((currentWidth / project.scalePixels) * project.scaleValue).toPrecision(2)} ${project.scaleUnit ?? ""}`
                      : `${currentWidth}px`}
                  </span>
                </div>
                <Slider value={[currentWidth]} min={0.5} max={10} step={0.5}
                  onValueChange={([v]) => setCurrentWidth(v)} />
              </div>
              <div className="flex flex-col gap-1 w-full items-center">
                <Label className="text-[9px] uppercase font-mono text-muted-foreground mb-1">色</Label>
                {["#000000","#FF0000","#0000FF","#00AA00","#FFFFFF"].map(c => (
                  <button key={c}
                    className={`w-6 h-6 rounded-full border-2 transition-all ${currentColor === c ? "border-primary scale-110" : "border-muted"}`}
                    style={{ backgroundColor: c }} onClick={() => setCurrentColor(c)} />
                ))}
              </div>
            </div>
          </div>

          {/* Canvas */}
          <div className="flex-1 relative bg-accent/10 flex flex-col"
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>

            {/* ── Stage tab bar ── */}
            {availableTabs.length > 0 && (
              <div className="shrink-0 flex border-b border-border bg-card px-2 gap-0 overflow-x-auto">
                {availableTabs.map(({ key, label, step }) => (
                  <button
                    key={key}
                    onClick={() => setViewTab(key)}
                    className={[
                      "px-3 py-2 text-[10px] font-mono border-b-2 transition-colors whitespace-nowrap flex items-center gap-1",
                      viewTab === key
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    {step !== null && (
                      <span className={`w-4 h-4 rounded-full text-[9px] flex items-center justify-center font-bold ${
                        viewTab === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      }`}>{step}</span>
                    )}
                    {label}
                  </button>
                ))}
              </div>
            )}

            {isDragging && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded pointer-events-none">
                <div className="text-center">
                  <ImagePlus className="w-12 h-12 text-primary mx-auto mb-2" />
                  <p className="font-mono text-sm text-primary">ここにドロップして読み込む</p>
                </div>
              </div>
            )}

            {showCamera && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90">
                <div className="flex flex-col items-center gap-4 p-6 bg-card border border-border rounded-lg shadow-xl max-w-lg w-full">
                  <div className="font-mono text-sm font-semibold">カメラ撮影</div>
                  <video ref={videoRef} autoPlay playsInline
                    className="w-full rounded border border-border max-h-80 bg-black object-contain" />
                  <div className="flex gap-3 w-full">
                    <Button className="flex-1 font-mono text-xs" onClick={shootCamera}>
                      <Camera className="w-4 h-4 mr-2" /> 撮影
                    </Button>
                    <Button variant="outline" className="flex-1 font-mono text-xs" onClick={closeCamera}>キャンセル</Button>
                  </div>
                </div>
              </div>
            )}

            {!project.imageUrl ? (
              <div className="absolute inset-0 flex items-center justify-center flex-col p-8">
                <div className="border border-dashed border-border p-12 rounded-lg bg-card/50 flex flex-col items-center text-center max-w-md w-full">
                  <ImagePlus className="w-12 h-12 text-muted-foreground mb-4 opacity-50" />
                  <h2 className="text-lg font-mono font-medium mb-2">写真が読み込まれていません</h2>
                  <p className="text-xs text-muted-foreground mb-6 font-mono">
                    画像または動画をドラッグ&amp;ドロップ、またはボタンで選択してください。
                  </p>
                  <div className="flex gap-2 w-full">
                    <Button className="flex-1 font-mono text-xs" onClick={() => fileInputRef.current?.click()}>
                      <FolderOpen className="w-4 h-4 mr-2" /> ファイルを開く
                    </Button>
                    <Button variant="outline" className="flex-1 font-mono text-xs" onClick={startCamera}>
                      <Camera className="w-4 h-4 mr-2" /> カメラで撮影
                    </Button>
                  </div>
                </div>
              </div>
            ) : lassoMode ? (
              <div className="flex-1 min-h-0">
                {imageDimensions ? (
                  <LassoEditor
                    imageUrl={project.imageUrl}
                    imageW={imageDimensions.w}
                    imageH={imageDimensions.h}
                    strokes={lassoStrokes}
                    activeKind={lassoKind}
                    onKindChange={setLassoKind}
                    onStrokeAdd={s => setLassoStrokes(prev => [...prev, s])}
                    onUndo={() => setLassoStrokes(prev => prev.slice(0, -1))}
                    onClear={() => setLassoStrokes([])}
                    onClose={() => setLassoMode(false)}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">

                {/* 手書き修正タブ専用: 参照背景ステージ選択バー (タブとは独立) */}
                {viewTab === "corrected" && (
                  <div className="flex items-center gap-1 px-3 py-1.5 border-b bg-muted/40 shrink-0 flex-wrap select-none">
                    <span className="text-[10px] font-mono text-muted-foreground mr-1 whitespace-nowrap">参照背景:</span>
                    {corrBgOptions.map(opt => (
                      <button
                        key={opt.key}
                        onClick={() => setCorrBgKey(opt.key)}
                        disabled={!opt.url}
                        className={[
                          "px-2 py-0.5 text-[10px] rounded border font-mono transition-colors",
                          corrBgKey === opt.key
                            ? "bg-primary text-primary-foreground border-primary"
                            : opt.url
                              ? "border-border text-muted-foreground hover:border-foreground hover:text-foreground cursor-pointer"
                              : "border-border/30 text-muted-foreground/30 cursor-not-allowed",
                        ].join(" ")}
                      >
                        {opt.label}
                      </button>
                    ))}

                    {/* 初期化ボタン: ストローク履歴をクリア */}
                    <button
                      onClick={handleCorrectionReset}
                      className="ml-3 px-2 py-0.5 text-[10px] rounded border font-mono transition-colors border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground cursor-pointer"
                    >
                      初期化
                    </button>

                    {/* 表示切替 */}
                    <div className="ml-2 flex items-center gap-1">
                      <button
                        onClick={() => setCorrBgVisible(v => !v)}
                        className={[
                          "px-2 py-0.5 text-[10px] rounded border font-mono transition-colors",
                          !corrBgVisible
                            ? "bg-muted-foreground/15 border-foreground/50 text-foreground"
                            : "border-border text-muted-foreground hover:border-foreground hover:text-foreground cursor-pointer",
                        ].join(" ")}
                      >
                        背景なし
                      </button>
                      <button
                        onClick={() => setCorrDraftVisible(v => !v)}
                        className={[
                          "px-2 py-0.5 text-[10px] rounded border font-mono transition-colors",
                          !corrDraftVisible
                            ? "bg-muted-foreground/15 border-foreground/50 text-foreground"
                            : "border-border text-muted-foreground hover:border-foreground hover:text-foreground cursor-pointer",
                        ].join(" ")}
                      >
                        canvasなし
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex-1 relative min-h-0">
                  <CanvasWorkspace
                    project={project}
                    annotations={annotations ?? null}
                    activeTool={activeTool}
                    currentColor={currentColor}
                    currentWidth={currentWidth}
                    undoTrigger={undoTrigger}
                    viewTab={viewTab}
                    intermediateImageUrl={intermediateImageUrl}
                    correctionBgUrl={activeCorrBgUrl}
                    correctionDraftUrl={undefined}
                    correctionBgVisible={corrBgVisible}
                    correctionDraftVisible={corrDraftVisible}
                    correctionResetKey={corrResetKey}
                    onScaleMeasured={info => setScalePending(info)}
                    onScaleAnnotationUndone={() => {
                      updateProject.mutate({ id, data: { scalePixels: 0, scaleValue: 0 } }, {
                        onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) }),
                      });
                    }}
                    pendingAnnotations={pendingAIAnnotations.length > 0 ? pendingAIAnnotations : undefined}
                    onPendingAnnotationsApplied={() => setPendingAIAnnotations([])}
                  />
                </div>
              </div>
            )}

          </div>

          {/* Right panel */}
          {showRightPanel && (
            <div className="w-80 border-l border-border bg-sidebar shrink-0 overflow-y-auto">

              {/* ── Pipeline stages ── */}
              <div className="p-4 border-b border-border space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-primary tracking-wide">処理ステージ</h3>
                  {sidecarOk === false && (
                    <span className="flex items-center gap-1 text-[9px] font-mono text-amber-500">
                      <AlertTriangle className="w-3 h-3" /> 処理エンジン未接続
                    </span>
                  )}
                  {sidecarOk === true && (
                    <span className="text-[9px] font-mono text-green-500">エンジン接続済み</span>
                  )}
                </div>

                {/* Mode selector */}
                <div className="space-y-1">
                  <Label className="text-[10px] font-mono text-muted-foreground uppercase">処理モード</Label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(Object.keys(MODE_LABEL) as PipelineMode[]).map(m => (
                      <Button key={m} variant={pipelineMode === m ? "default" : "outline"} size="sm"
                        className="font-mono text-[10px] h-7 px-2"
                        onClick={() => setPipelineMode(m)}>
                        {MODE_LABEL[m]}
                      </Button>
                    ))}
                  </div>
                </div>

                <Separator />

                {/* Stage 0: 原本画像 */}
                <StepCard
                  step={0} title="元の写真" description="アップロード済みの原本画像"
                  status={project.imageUrl ? "done" : "pending"}
                  canRun={false}
                  thumbnail={project.imageUrl || undefined}
                  isActive={viewTab === "original"}
                  onView={project.imageUrl ? () => setViewTab("original") : undefined}
                />

                {/* Stage 1: 投げ縄選択 */}
                <StepCard
                  step={1} title="投げ縄選択"
                  description="対象物を投げ縄で囲んで選択範囲を指定する（Stage 1）"
                  status={runningStage === 1 ? "running" : stageImages.stage1_selected ? "done" : "pending"}
                  canRun={!!project.imageUrl && runningStage === null}
                  onRun={handleRunStages12}
                  thumbnail={stageImages.stage1_selected}
                  isActive={viewTab === "step2"}
                  onView={stageImages.stage1_selected ? () => setViewTab("step2") : undefined}
                >
                  {!stageImages.stage1_selected && (
                    <div className="space-y-1.5">
                      <Button
                        size="sm"
                        variant={lassoStrokes.length > 0 ? "outline" : "default"}
                        className="w-full text-[10px] h-7"
                        onClick={() => { setViewTab("original"); setLassoMode(true); }}
                        disabled={!project.imageUrl || runningStage !== null}
                      >
                        {lassoStrokes.length > 0
                          ? `描画済み（含む ${lassoStrokes.filter(s => s.kind === "include").length} / 除外 ${lassoStrokes.filter(s => s.kind === "exclude").length}）`
                          : "対象を囲む"}
                      </Button>
                      {lassoStrokes.length === 0 && (
                        <p className="text-[8px] font-mono text-amber-500/80">
                          ※ 投げ縄で対象を囲んでから「実行」してください
                        </p>
                      )}
                    </div>
                  )}
                </StepCard>

                {/* Stage 2: 特徴線強調（Stage 1 と同時実行） */}
                <StepCard
                  step={2} title="特徴線強調"
                  description="陰影・テクスチャを除去し特徴線を強調する（Stage 2、Stage 1 と同時実行）"
                  status={runningStage === 1 ? "running" : stageImages.feature_removed ? "done" : "pending"}
                  canRun={false}
                  thumbnail={stageImages.feature_removed}
                  isActive={viewTab === "step3"}
                  onView={stageImages.feature_removed ? () => setViewTab("step3") : undefined}
                />

                {/* Stage 3: エッジ抽出 */}
                <StepCard
                  step={3} title="エッジ抽出"
                  description="特徴線強調画像から構造エッジを検出する（Stage 3）"
                  status={runningStage === 3 ? "running" : stageImages.edge_extracted ? "done" : "pending"}
                  canRun={!!stageNodeIds.feature_removed && runningStage === null}
                  onRun={handleAdvanceEdge}
                  thumbnail={stageImages.edge_extracted}
                  isActive={viewTab === "step4"}
                  onView={stageImages.edge_extracted ? () => setViewTab("step4") : undefined}
                />

                {/* Stage 4: 手書き修正（最終段階 — パイプライン外） */}
                <StepCard
                  step={4} title="手書き修正"
                  description="エッジ抽出結果を参照しながらペン・消しゴムで手書き修正"
                  status={project.lineArtUrl ? "done" : "pending"}
                  canRun={false}
                  thumbnail={project.lineArtUrl || undefined}
                  isActive={viewTab === "corrected"}
                  onView={(stageImages.edge_extracted || project.lineArtUrl) ? () => { setViewTab("corrected"); setActiveTool("pen"); } : undefined}
                >
                  {!stageImages.edge_extracted && !project.lineArtUrl && (
                    <p className="text-[8px] font-mono text-muted-foreground">
                      Stage 3「エッジ抽出」を実行すると修正キャンバスが有効になります。
                    </p>
                  )}
                </StepCard>


                {nodeCount > 0 && (
                  <p className="text-[9px] font-mono text-muted-foreground">
                    パイプラインツリー: {nodeCount} ノード
                  </p>
                )}
              </div>

            </div>
          )}
        </div>
      </div>

      {/* ── スケール設定モーダル ── */}
      {scalePending !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-2xl p-6 w-80 space-y-4">
            <h2 className="font-mono text-sm font-semibold">スケール設定</h2>
            <p className="text-xs font-mono text-muted-foreground">
              計測距離：<span className="text-foreground font-semibold">{scalePending.pixels}px</span>
            </p>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground">実寸</Label>
                <input
                  type="number" min="0.001" step="any" value={scaleValue}
                  onChange={e => setScaleValue(e.target.value)}
                  className="w-full px-2 py-1.5 rounded border border-border bg-background font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="w-24 space-y-1">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground">単位</Label>
                <select
                  value={scaleUnit} onChange={e => setScaleUnit(e.target.value)}
                  className="w-full px-2 py-1.5 rounded border border-border bg-background font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="mm">mm</option>
                  <option value="cm">cm</option>
                  <option value="µm">µm</option>
                  <option value="inch">inch</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button className="flex-1 font-mono text-xs" onClick={confirmScale}>確定</Button>
              <Button variant="outline" className="flex-1 font-mono text-xs" onClick={() => setScalePending(null)}>キャンセル</Button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TB({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick}
          className={`w-full flex flex-col items-center justify-center gap-0.5 py-1.5 rounded transition-colors ${
            active
              ? "text-primary bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-accent"
          }`}>
          <span className="flex items-center justify-center w-4 h-4">{icon}</span>
          <span className="text-[7px] leading-none">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

type StepStatus = "pending" | "running" | "done";

function StepCard({
  step, title, description, status, canRun, onRun,
  thumbnail, isActive, onView, badge, badgeOk, children,
}: {
  step: number;
  title: string;
  description: string;
  status: StepStatus;
  canRun: boolean;
  onRun?: () => void;
  thumbnail?: string;
  isActive?: boolean;
  onView?: () => void;
  badge?: string;
  badgeOk?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded border transition-colors relative overflow-hidden ${
      isActive ? "border-primary/30 bg-primary/5" : "border-border bg-card/60"
    }`}>
      {/* Left status bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${
        status === "done"    ? "bg-green-500/60" :
        status === "running" ? "bg-primary animate-pulse" :
                               "bg-transparent"
      }`} />

      {/* Header row */}
      <div className="flex items-center gap-2 p-2 pl-3">
        <span className={`w-5 h-5 rounded-full text-[9px] font-mono font-bold flex items-center justify-center shrink-0 ${
          status === "done"    ? "bg-green-500/15 text-green-600 dark:text-green-400" :
          status === "running" ? "bg-primary/20 text-primary animate-pulse" :
                                 "bg-muted text-muted-foreground"
        }`}>{step}</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium leading-none">{title}</span>
            {status === "done" && <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />}
            {badge && (
              <span className={`text-[9px] font-mono px-1 py-0.5 rounded ${badgeOk ? "bg-green-500/10 text-green-500" : "bg-amber-500/10 text-amber-500"}`}>
                {badge}
              </span>
            )}
          </div>
          <p className="text-[9px] text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        </div>

        {thumbnail && onView && (
          <button onClick={onView}
            className={`w-10 h-10 rounded border shrink-0 overflow-hidden transition-all ${
              isActive ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50"
            }`}>
            <img src={thumbnail} alt="" className="w-full h-full object-cover" />
          </button>
        )}

        {!thumbnail && onView && (
          <button onClick={onView} className="text-muted-foreground hover:text-primary transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {children && (
        <div className="px-3 pb-2 border-t border-border/50 pt-2 space-y-2">
          {children}
        </div>
      )}

      {onRun && (
        <div className="px-2 pb-2">
          {status === "running" ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[9px] text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin text-primary" /> 処理中…
            </div>
          ) : (
            <Button size="sm" className="w-full text-[10px] h-7"
              onClick={onRun}
              disabled={!canRun}
              variant={status === "done" ? "outline" : "default"}>
              {status === "done" ? "再実行" : "実行"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
