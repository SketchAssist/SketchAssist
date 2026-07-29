/**
 * SketchAssist パイプライン API クライアント
 *
 * Python サイドカー（packages/python-sidecar/runner.py）へ直接アクセスする。
 * デフォルトでは http://127.0.0.1:8765 を使用する。
 * 環境変数 VITE_SIDECAR_URL で上書き可能。
 *
 * ── パイプラインのステージ構成 ──
 *   Stage 0: 原本画像 (original)
 *   Stage 1: 範囲選択 (stage1_selected)  ← 投げ縄オプション
 *   Stage 2: 特徴線強調 (feature_removed) ← 陰影・テクスチャ除去
 *   Stage 3: エッジ抽出 (edge_extracted)
 *
 * ── 更新方法 ──
 * Python ファイルを上書きしてサイドカーを再起動するだけでよい。
 * このファイル（クライアント層）は変更不要。
 */

// ── 型定義 ────────────────────────────────────────────────────────

export type StageType =
  | "original"
  | "stage1_selected"
  | "feature_removed"
  | "edge_extracted";

export type PipelineMode = "insect" | "plant" | "fossil" | "artifact" | "general";

export interface PipelineNode {
  id: string;
  stage_type: StageType;
  label: string;
  params: Record<string, unknown>;
  parent_id: string | null;
  image_filename: string | null;
  extra_files: Record<string, string>;
}

export interface PipelineTree {
  root_id: string | null;
  nodes: Record<string, PipelineNode>;
}

export interface RunPipelineResult {
  ok: true;
  result: {
    root_id: string;
    stage1_id: string;
    feature_id: string;
  };
}

export interface AdvanceResult {
  ok: true;
  result: { node_id: string };
}

export interface BranchResult {
  ok: true;
  result: { node_id: string };
}

export interface NodeImageResult {
  ok: true;
  /** base64 エンコードされた PNG 画像 */
  image_b64: string;
  format: string;
}

export interface NodeExtraResult {
  ok: true;
  content: string;
  key: string;
}

// ── ポリゴン型（投げ縄選択用） ─────────────────────────────────────

/** [x, y] の 2 次元座標点 */
export type Point2D = [number, number];
/** 1 つのポリゴン（3 点以上必要） */
export type Polygon = Point2D[];

// ── ベース URL ────────────────────────────────────────────────────

/** Python サイドカーのベース URL
 *  ブラウザからは Vite のプロキシ（/sidecar → 127.0.0.1:8765）経由でアクセスする。
 *  VITE_SIDECAR_URL を設定すれば上書き可能（本番デプロイ等）。
 */
function sidecarBase(): string {
  return (import.meta.env["VITE_SIDECAR_URL"] as string | undefined) ?? "/sidecar";
}

/**
 * Electron 環境(window.sketchAssistSidecar が存在する場合)では、
 * サイドカーは起動のたびに動的なポートで待ち受けているため、
 * preload 経由で実際のポート番号を問い合わせてベースURLを組み立てる。
 * それ以外(ブラウザ/Vite dev server 等)では、従来通り sidecarBase() を使う。
 * 一度解決した結果は使い回す(毎リクエストごとにIPC往復しないため)。
 */
let cachedSidecarBasePromise: Promise<string> | null = null;

async function resolveSidecarBase(): Promise<string> {
  if (cachedSidecarBasePromise) return cachedSidecarBasePromise;

  const bridge = (window as unknown as {
    sketchAssistSidecar?: { getPort: () => Promise<number> };
  }).sketchAssistSidecar;

  cachedSidecarBasePromise = bridge
    ? bridge.getPort()
        .then((port) => `http://127.0.0.1:${port}`)
        .catch(() => sidecarBase())
    : Promise.resolve(sidecarBase());

  return cachedSidecarBasePromise;
}

/** projectId (整数) → サイドカーが使う project_id 文字列 */
function toSidecarProjectId(projectId: number): string {
  return `proj_${projectId}`;
}

async function sidecarFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${await resolveSidecarBase()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string; detail?: string };
      if (body.error) message = body.error;
      else if (body.detail) message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ── パブリック API ────────────────────────────────────────────────

/**
 * Python サイドカーが起動しているか確認する。
 */
export async function checkSidecarAvailable(): Promise<boolean> {
  try {
    await sidecarFetch<{ status: string }>("/health");
    return true;
  } catch {
    return false;
  }
}

/**
 * パイプライン Stage 0〜2 を実行する。
 */
export async function runPipeline(
  projectId: number,
  imageB64: string,
  mode: PipelineMode,
  options?: {
    includePolygons?: Polygon[];
    excludePolygons?: Polygon[];
  },
): Promise<RunPipelineResult> {
  return sidecarFetch<RunPipelineResult>("/pipeline/run", {
    method: "POST",
    body: JSON.stringify({
      project_id:       toSidecarProjectId(projectId),
      image_b64:        imageB64,
      mode,
      include_polygons: options?.includePolygons ?? null,
      exclude_polygons: options?.excludePolygons ?? null,
    }),
  });
}

/**
 * 指定ノードから次の Stage へ 1 ステップ進む。
 */
export async function advanceStage(
  projectId: number,
  nodeId: string,
  mode: PipelineMode,
  options?: {
    includePolygons?: Polygon[];
    excludePolygons?: Polygon[];
  },
): Promise<AdvanceResult> {
  return sidecarFetch<AdvanceResult>("/pipeline/advance", {
    method: "POST",
    body: JSON.stringify({
      project_id:       toSidecarProjectId(projectId),
      node_id:          nodeId,
      mode,
      include_polygons: options?.includePolygons ?? null,
      exclude_polygons: options?.excludePolygons ?? null,
    }),
  });
}

/**
 * 指定ノードから新しいパラメータで分岐する。
 */
export async function branchStage(
  projectId: number,
  parentId: string,
  stageType: StageType,
  params: Record<string, unknown>,
  label: string,
): Promise<BranchResult> {
  return sidecarFetch<BranchResult>("/pipeline/branch", {
    method: "POST",
    body: JSON.stringify({
      project_id:  toSidecarProjectId(projectId),
      parent_id:   parentId,
      stage_type:  stageType,
      params,
      label,
    }),
  });
}

/**
 * プロジェクトのステージツリー全体を取得する。
 */
export async function fetchPipelineTree(projectId: number): Promise<PipelineTree> {
  const res = await sidecarFetch<{ ok: true; root_id: string | null; nodes: Record<string, PipelineNode> }>(
    `/pipeline/${toSidecarProjectId(projectId)}/tree`,
  );
  return { root_id: res.root_id, nodes: res.nodes };
}

/**
 * 指定ノードの中間画像を base64 PNG で取得する。
 */
export async function fetchNodeImage(
  projectId: number,
  nodeId: string,
): Promise<NodeImageResult> {
  return sidecarFetch<NodeImageResult>(
    `/pipeline/${toSidecarProjectId(projectId)}/node/${encodeURIComponent(nodeId)}/image`,
  );
}

/**
 * 指定ノードの追加成果物（SVG / faces_json / graph_json など）を取得する。
 */
export async function fetchNodeExtra(
  projectId: number,
  nodeId: string,
  key: string,
): Promise<NodeExtraResult> {
  return sidecarFetch<NodeExtraResult>(
    `/pipeline/${toSidecarProjectId(projectId)}/node/${encodeURIComponent(nodeId)}/extra/${key}`,
  );
}

// ── ユーティリティ ────────────────────────────────────────────────

/**
 * base64 PNG 文字列を data URL に変換する。
 */
export function b64ToDataUrl(b64: string, mimeType = "image/png"): string {
  return `data:${mimeType};base64,${b64}`;
}

/**
 * HTML canvas または img element から base64 PNG 文字列を取得する。
 */
export function canvasToB64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");
}

/**
 * File / Blob を base64 PNG 文字列に変換する（async）。
 */
export function fileToB64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.replace(/^data:image\/[a-z]+;base64,/, ""));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
