/**
 * mask-editor.ts — Direct pixel-level mask editing for subject extraction
 *
 * Provides four interactive editing tools that work ON the computed mask output,
 * bypassing full recomputation for fast iterative corrections:
 *
 *   1. 保持ブラシ  — paint pixels as forced foreground (green overlay)
 *   2. 削除ブラシ  — paint pixels as forced background (red overlay)
 *   3. 投げ縄選択  — freehand polygon selection → apply keep / delete
 *   4. ワンクリック物体削除 — BFS flood fill from click point → mark BG
 *
 * Convention
 *   bgMask values : 0 = foreground (subject), 255 = background
 *   edits  values : 0 = no override, 1 = force FG, 255 = force BG
 */

// ─── Types ─────────────────────────────────────────────────────────────────

/** Per-pixel override layer.  0 = no override, 1 = force FG, 255 = force BG. */
export type MaskEdits = Uint8Array;

export type MaskTool =
  | "seed_fg"
  | "seed_support"
  | "seed_bg"
  | "brush_keep"
  | "brush_delete"
  | "flood_delete"
  | "flood_keep"
  | "lasso_keep"
  | "lasso_delete";

export interface MaskQuality {
  score: number;            // 0–100 overall quality
  bgResidueRatio: number;   // fraction of FG area with background-like (very light) colour
  fragmentCount: number;    // number of connected FG components (ideally 1)
  largestFraction: number;  // fraction of FG pixels in the largest component
  warnings: string[];       // human-readable quality warnings
}

export interface LineartQuality {
  score: number;            // 0–100
  edgeDensity: number;      // edge pixels / subject area pixels
  continuityRatio: number;  // fraction of edge pixels in chains ≥ 10px
  warnings: string[];
}

// ─── StructureLine types (moved from sketch-pipeline.ts) ────────────────────

export interface StructureLineVertex {
  x:             number;
  y:             number;
  /** Normalized fused gradient magnitude at this point (0.0–1.0). */
  edgeStrength:  number;
  /** Scharr gradient direction (0–π radians). Perpendicular to the edge tangent. */
  edgeDirection: number;
  /** Local chain continuity: 0=endpoint/isolated, 0.5=interior chain pixel, 1=branch. */
  continuity:    number;
  /** Estimated line width in pixels (from distance transform). */
  lineWidth:     number;
  /** Local contrast proxy: same as edgeStrength. */
  localContrast: number;
  /** Local curvature: angle change (radians) between prev→this→next tangent vectors. */
  curvature:     number;
}

export type StructureLineLayer = "outline" | "structural" | "detail";

/** Per-criterion weighted contribution to an integratePolylines merge decision. */
export interface MergeReason {
  distance:       number;
  tangent:        number;
  curvature:      number;
  width:          number;
  lengthBalance:  number;
  sharedEndpoint: number;
  totalScore:     number;
}

/** Per-polyline geometric features. */
export interface PolylineFeatures {
  avgCurvature:  number;
  tangentStart:  { x: number; y: number };
  tangentEnd:    { x: number; y: number };
  branchCount:   number;
  endpointStart: { x: number; y: number };
  endpointEnd:   { x: number; y: number };
}

/** Per-polyline quality scores. */
export interface PolylineQualityScore {
  continuity:            number;
  smoothness:            number;
  curvatureConsistency:  number;
  widthStability:        number;
  noiseLikelihood:       number;
  trackingReliability:   number;
  isolation:             number;
  overall:               number;
}

/** An extracted structure polyline with per-vertex attributes. */
export interface StructureLine {
  /** Unique identifier assigned by computePolylineAggregates (format: "pl_N"). */
  id?: string;
  vertices: StructureLineVertex[];
  /** Which tier this line belongs to (outer contour / main structure / fine detail). */
  layer:    StructureLineLayer;
  /** True when the polyline returns to its start pixel (closed contour). */
  closed:   boolean;
  /** Pixel length — equal to vertices.length. */
  pixelLen: number;
  length: number;
  avgEdgeStrength: number;
  avgLineWidth: number;
  boundingBox: { x: number; y: number; w: number; h: number };
  primaryRegionId: number;
  secondaryRegionId?: number;
  features?: PolylineFeatures;
  qualityScore?: PolylineQualityScore;
  mergeReason?: MergeReason;
}

// ─── Direction constants ────────────────────────────────────────────────────

const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];

// ─── Core operations ───────────────────────────────────────────────────────

/** Create an empty (all-zero) edit layer for an image of n pixels. */
export function createEdits(n: number): MaskEdits {
  return new Uint8Array(n);
}

/**
 * Merge base mask with edit overlay.
 * Returns a NEW Uint8Array:  0 = foreground, 255 = background.
 */
export function applyEdits(baseMask: Uint8Array, edits: MaskEdits): Uint8Array {
  const merged = new Uint8Array(baseMask);
  for (let i = 0; i < merged.length; i++) {
    if (edits[i] === 1)   merged[i] = 0;   // force foreground
    if (edits[i] === 255) merged[i] = 255; // force background
  }
  return merged;
}

/**
 * Render a mask as a coloured overlay over the original image data.
 *
 * Colour coding
 *   Foreground (unedited) : original colour
 *   Background            : red tint   (bgMask=255 or edit=255)
 *   Direct-keep edit      : green tint (edit=1)
 *
 * Returns a PNG data URL.
 */
export function renderMaskPreview(
  origData: Uint8ClampedArray,
  w: number, h: number,
  bgMask: Uint8Array,
  edits?: MaskEdits,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx  = canvas.getContext("2d")!;
  const imgd = ctx.createImageData(w, h);
  const d    = imgd.data;

  for (let i = 0; i < w * h; i++) {
    const r = origData[i * 4], g = origData[i * 4 + 1], b = origData[i * 4 + 2];
    const isKeep   = edits !== undefined && edits[i] === 1;
    const isDelete = edits !== undefined && edits[i] === 255;
    const isBg     = bgMask[i] !== 0;

    if (isKeep) {
      // Green tint: direct force-foreground paint
      d[i*4]   = Math.round(r * 0.25);
      d[i*4+1] = Math.round(g * 0.25 + 165 * 0.75);
      d[i*4+2] = Math.round(b * 0.25 + 55  * 0.75);
      d[i*4+3] = 255;
    } else if (isDelete || isBg) {
      // Red tint: background or direct force-delete
      d[i*4]   = Math.round(r * 0.2 + 210 * 0.8);
      d[i*4+1] = Math.round(g * 0.2);
      d[i*4+2] = Math.round(b * 0.2);
      d[i*4+3] = 255;
    } else {
      d[i*4] = r; d[i*4+1] = g; d[i*4+2] = b; d[i*4+3] = 255;
    }
  }
  ctx.putImageData(imgd, 0, 0);
  return canvas.toDataURL("image/png");
}

// ─── Brush tool ─────────────────────────────────────────────────────────────

/**
 * 保持ブラシ / 削除ブラシ
 *
 * Paint a circular brush at each given image-pixel point.
 *   kind = "keep"   → force foreground (edit code 1)
 *   kind = "delete" → force background (edit code 255)
 * Returns a new MaskEdits array (original untouched).
 */
export function applyBrushStroke(
  edits: MaskEdits,
  w: number, h: number,
  points: ReadonlyArray<{ x: number; y: number }>,
  kind: "keep" | "delete",
  radius: number,
): MaskEdits {
  const newEdits = new Uint8Array(edits);
  const value    = kind === "keep" ? 1 : 255;
  const r2       = radius * radius;

  for (const pt of points) {
    const cx = Math.round(pt.x), cy = Math.round(pt.y);
    const x0 = Math.max(0, cx - radius),   x1 = Math.min(w - 1, cx + radius);
    const y0 = Math.max(0, cy - radius),   y1 = Math.min(h - 1, cy + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) {
          newEdits[y * w + x] = value;
        }
      }
    }
  }
  return newEdits;
}

// ─── Flood delete ───────────────────────────────────────────────────────────

/**
 * ワンクリック物体削除
 *
 * BFS from (startX, startY) within the CURRENT foreground region.
 * Expands only to foreground pixels within colorTolerance (weighted L2 RGB distance)
 * of the seed colour.  Marks the entire discovered connected region as force-background.
 *
 * This lets researchers click on a branch, pin, or background patch once
 * to remove the entire object in a single interaction.
 *
 * @param colorTolerance  Max weighted Euclidean distance (0–255 scale).  Lower =
 *   stricter colour matching; higher = larger flood area.  Default 35 works well
 *   for specimens on uniform supports.
 */
export function floodDelete(
  baseMask: Uint8Array,
  edits: MaskEdits,
  origData: Uint8ClampedArray,
  w: number, h: number,
  startX: number, startY: number,
  colorTolerance = 35,
): MaskEdits {
  const merged = applyEdits(baseMask, edits);
  const si     = startY * w + startX;
  if (si < 0 || si >= w * h) return edits;
  if (merged[si] !== 0) return edits; // clicked on background — nothing to do

  const sr = origData[si * 4], sg = origData[si * 4 + 1], sb = origData[si * 4 + 2];
  const tol2 = colorTolerance * colorTolerance;

  const newEdits = new Uint8Array(edits);
  const inQueue  = new Uint8Array(w * h);
  const queue: number[] = [si];
  inQueue[si]  = 1;
  newEdits[si] = 255;

  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const cy  = (idx / w) | 0, cx = idx % w;

    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + DX4[dir], ny = cy + DY4[dir];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (inQueue[ni] || merged[ni] !== 0) continue; // already visited or background

      // Perceptual (luma-weighted) colour distance from seed pixel
      const dr = origData[ni * 4] - sr;
      const dg = origData[ni * 4 + 1] - sg;
      const db = origData[ni * 4 + 2] - sb;
      if (dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114 > tol2) continue;

      inQueue[ni]  = 1;
      newEdits[ni] = 255;
      queue.push(ni);
    }
  }
  return newEdits;
}

// ─── Flood keep ─────────────────────────────────────────────────────────────

/**
 * ワンクリック物体保持
 *
 * BFS from (startX, startY) within the CURRENT background region.
 * Expands only to background pixels within colorTolerance of the seed colour.
 * Marks the entire discovered connected region as force-foreground (edit code 1).
 *
 * This lets researchers click on a falsely-removed region once to restore it.
 */
export function floodKeep(
  baseMask: Uint8Array,
  edits: MaskEdits,
  origData: Uint8ClampedArray,
  w: number, h: number,
  startX: number, startY: number,
  colorTolerance = 35,
): MaskEdits {
  const merged = applyEdits(baseMask, edits);
  const si     = startY * w + startX;
  if (si < 0 || si >= w * h) return edits;
  if (merged[si] === 0) return edits; // clicked on foreground — nothing to restore

  const sr = origData[si * 4], sg = origData[si * 4 + 1], sb = origData[si * 4 + 2];
  const tol2 = colorTolerance * colorTolerance;

  const newEdits = new Uint8Array(edits);
  const inQueue  = new Uint8Array(w * h);
  const queue: number[] = [si];
  inQueue[si]  = 1;
  newEdits[si] = 1;

  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const cy  = (idx / w) | 0, cx = idx % w;

    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + DX4[dir], ny = cy + DY4[dir];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (inQueue[ni] || merged[ni] === 0) continue; // already visited or foreground

      const dr = origData[ni * 4] - sr;
      const dg = origData[ni * 4 + 1] - sg;
      const db = origData[ni * 4 + 2] - sb;
      if (dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114 > tol2) continue;

      inQueue[ni]  = 1;
      newEdits[ni] = 1;
      queue.push(ni);
    }
  }
  return newEdits;
}

// ─── Lasso tool ─────────────────────────────────────────────────────────────

/**
 * 投げ縄選択
 *
 * Fill the interior of the given polygon with keep (1) or delete (255).
 * Uses even-odd scanline rasterisation.
 * polygon must have ≥ 3 points in image-pixel coordinates (closed automatically).
 */
export function lassoApply(
  edits: MaskEdits,
  w: number, h: number,
  polygon: ReadonlyArray<{ x: number; y: number }>,
  kind: "keep" | "delete",
): MaskEdits {
  if (polygon.length < 3) return edits;
  const newEdits = new Uint8Array(edits);
  const value    = kind === "keep" ? 1 : 255;
  const n        = polygon.length;
  const minY     = Math.max(0,     Math.floor(Math.min(...polygon.map(p => p.y))));
  const maxY     = Math.min(h - 1, Math.ceil (Math.max(...polygon.map(p => p.y))));

  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const j  = (i + 1) % n;
      const yi = polygon[i].y, yj = polygon[j].y;
      if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
        xs.push(polygon[i].x + (y - yi) / (yj - yi) * (polygon[j].x - polygon[i].x));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0,     Math.ceil (xs[k]));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) newEdits[y * w + x] = value;
    }
  }
  return newEdits;
}

// ─── Quality evaluation ─────────────────────────────────────────────────────

/**
 * 品質自動評価 — マスク
 *
 * Checks:
 *   bgResidueRatio   fraction of FG pixels that are very light (≥ 225 luma),
 *                    indicating background paper / white supports not masked out
 *   fragmentCount    number of connected FG components (ideally 1 for a single specimen)
 *   largestFraction  fraction of FG pixels in the largest component
 */
export function evaluateMask(
  bgMask: Uint8Array,
  origData: Uint8ClampedArray,
  w: number, h: number,
): MaskQuality {
  const n       = w * h;
  let fgCount   = 0;
  let lightInFg = 0;

  for (let i = 0; i < n; i++) {
    if (bgMask[i]) continue;
    fgCount++;
    const luma = 0.299 * origData[i * 4] + 0.587 * origData[i * 4 + 1] + 0.114 * origData[i * 4 + 2];
    if (luma > 225) lightInFg++;
  }

  const bgResidueRatio = fgCount > 0 ? lightInFg / fgCount : 0;

  // 4-connected BFS to count and size connected components
  const visited = new Uint8Array(n);
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (bgMask[s] || visited[s]) continue;
    const q: number[] = [s];
    visited[s] = 1;
    let sz = 0, qi = 0;
    while (qi < q.length) {
      const idx = q[qi++];
      sz++;
      const cy = (idx / w) | 0, cx = idx % w;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX4[d], ny = cy + DY4[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bgMask[ni] && !visited[ni]) { visited[ni] = 1; q.push(ni); }
      }
    }
    sizes.push(sz);
  }

  const largest         = sizes.length ? Math.max(...sizes) : 0;
  const largestFraction = fgCount > 0 ? largest / fgCount : 0;
  const fragmentCount   = sizes.length;

  const warnings: string[] = [];
  if (fgCount === 0) {
    warnings.push("対象が検出されていません");
  } else {
    if (bgResidueRatio > 0.20)
      warnings.push(`背景残留: 前景領域の ${Math.round(bgResidueRatio * 100)}% が背景色`);
    if (fragmentCount > 8 && largestFraction < 0.6)
      warnings.push(`断片化: ${fragmentCount} 個の独立領域`);
    if (fgCount < n * 0.01)
      warnings.push("対象が画像の 1% 未満 — 範囲が小さすぎます");
  }

  let score = 100;
  score -= Math.round(bgResidueRatio * 120);
  score -= Math.max(0, fragmentCount - 8) * 2;
  if (largestFraction < 0.5 && fragmentCount > 3) score -= 15;
  score = Math.max(0, Math.min(100, score));

  return { score, bgResidueRatio, fragmentCount, largestFraction, warnings };
}

/**
 * 品質自動評価 — 線画
 *
 * Checks:
 *   edgeDensity      edge pixels / subject-area pixels.
 *                    Too high → noisy; too low → over-smoothed / missing structure.
 *   continuityRatio  fraction of edge pixels that belong to chains ≥ 10 px long.
 *                    Low ratio → many isolated dots = noise or shadow artifacts.
 */
export function evaluateLineart(
  lines: StructureLine[],   // StructureLine array from Step4Result
  bgMask: Uint8Array,       // mask from step 2: 0 = FG, 255 = BG
  w: number, h: number,
): LineartQuality {
  const n = w * h;
  let subjectArea = 0;
  for (let i = 0; i < n; i++) if (!bgMask[i]) subjectArea++;

  // Edge pixel count: sum of vertex counts across all StructureLines (approximation)
  let edgeCount  = 0;
  let longEdgePx = 0;
  for (const ln of lines) {
    const len = ln.vertices.length;
    edgeCount  += len;
    if (len >= 10) longEdgePx += len;
  }

  const edgeDensity    = subjectArea > 0 ? edgeCount / subjectArea : 0;
  const continuityRatio = edgeCount > 0 ? longEdgePx / edgeCount : 0;

  const warnings: string[] = [];
  if (edgeDensity > 0.40) warnings.push(`線密度過剰: ${Math.round(edgeDensity * 100)}% (ノイズの可能性)`);
  if (edgeDensity < 0.03) warnings.push(`線が少なすぎます: ${Math.round(edgeDensity * 100)}%`);
  if (continuityRatio < 0.50) warnings.push(`線の不連続: 短い断片が多い (連続率 ${Math.round(continuityRatio * 100)}%)`);

  let score = 100;
  if (edgeDensity > 0.40) score -= Math.round((edgeDensity - 0.40) * 200);
  if (edgeDensity < 0.03) score -= 30;
  if (continuityRatio < 0.50) score -= Math.round((0.50 - continuityRatio) * 60);
  score = Math.max(0, Math.min(100, score));

  return { score, edgeDensity, continuityRatio, warnings };
}
