/**
 * local-db.ts
 * localStorage ベースのプロジェクト・アノテーションストア。
 * api-server / @workspace/api-client-react の代替として機能する。
 */

// ── 型定義 ─────────────────────────────────────────────────────────────────

export type ProjectPreset = "insect" | "plant" | "fossil" | "artifact" | "general";
export type ProjectStatus = "empty" | "has_image" | "processed" | "annotated";

/** @workspace/api-client-react の ProjectInputPreset 互換 */
export type ProjectInputPreset = typeof ProjectInputPreset[keyof typeof ProjectInputPreset];
export const ProjectInputPreset = {
  insect:   "insect",
  artifact: "artifact",
  fossil:   "fossil",
  plant:    "plant",
} as const;

export type ProjectPresetConst = typeof ProjectInputPreset[keyof typeof ProjectInputPreset];

export interface Project {
  id: number;
  name: string;
  description?: string | null;
  preset: ProjectPreset;
  imageUrl?: string | null;
  lineArtUrl?: string | null;
  lineArtSvg?: string | null;
  scaleValue?: number | null;
  scaleUnit?: string | null;
  scalePixels?: number | null;
  status?: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export type LayerInfoType = typeof LayerInfoType[keyof typeof LayerInfoType];
export const LayerInfoType = {
  original:   "original",
  lineart:    "lineart",
  annotation: "annotation",
} as const;

export interface LayerInfo {
  id: string;
  name: string;
  type: LayerInfoType;
  visible: boolean;
  opacity: number;
  order: number;
}

export interface LayerConfig {
  projectId: number;
  layers: LayerInfo[];
}

export type StrokeTool = typeof StrokeTool[keyof typeof StrokeTool];
export const StrokeTool = {
  pen:    "pen",
  eraser: "eraser",
} as const;

export interface Stroke {
  id: string;
  points: number[];
  color: string;
  width: number;
  tool: StrokeTool;
}

export type TextAnnotationKind = typeof TextAnnotationKind[keyof typeof TextAnnotationKind];
export const TextAnnotationKind = {
  text:  "text",
  scale: "scale",
} as const;

export interface TextAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color?: string;
  kind?: TextAnnotationKind;
  x2?: number;
  y2?: number;
}

export interface AnnotationData {
  projectId: number;
  strokes: Stroke[];
  textAnnotations?: TextAnnotation[];
}

export interface ProjectStats {
  totalProjects: number;
  byPreset: Record<string, number>;
  byStatus: Record<string, number>;
  recentProjects: Project[];
}

// ── ストレージキー ──────────────────────────────────────────────────────────

const PROJECTS_KEY   = "sa_projects";
const LAYERS_KEY     = (id: number) => `sa_layers_${id}`;
const ANNOTS_KEY     = (id: number) => `sa_annots_${id}`;
const ID_SEQ_KEY     = "sa_id_seq";

// ── 内部ヘルパー ────────────────────────────────────────────────────────────

function nextId(): number {
  const n = parseInt(localStorage.getItem(ID_SEQ_KEY) ?? "0", 10);
  const next = n + 1;
  localStorage.setItem(ID_SEQ_KEY, String(next));
  return next;
}

function readProjects(): Project[] {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]") as Project[];
  } catch {
    return [];
  }
}

function writeProjects(list: Project[]): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
}

function defaultLayers(projectId: number): LayerConfig {
  return {
    projectId,
    layers: [
      { id: "original",   name: "原写真",     type: "original",   visible: true, opacity: 1.0, order: 0 },
      { id: "lineart",    name: "線画",       type: "lineart",    visible: true, opacity: 1.0, order: 1 },
      { id: "annotation", name: "手描き修正", type: "annotation", visible: true, opacity: 1.0, order: 2 },
    ],
  };
}

function defaultAnnotations(projectId: number): AnnotationData {
  return { projectId, strokes: [], textAnnotations: [] };
}

// ── プロジェクト CRUD ───────────────────────────────────────────────────────

export function dbListProjects(): Project[] {
  return readProjects().sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function dbGetProject(id: number): Project | null {
  return readProjects().find(p => p.id === id) ?? null;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  preset: ProjectInputPreset;
}

export function dbCreateProject(input: CreateProjectInput): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id:          nextId(),
    name:        input.name,
    description: input.description ?? null,
    preset:      input.preset as ProjectPreset,
    status:      "empty",
    imageUrl:    null,
    lineArtUrl:  null,
    lineArtSvg:  null,
    scaleValue:  null,
    scaleUnit:   null,
    scalePixels: null,
    createdAt:   now,
    updatedAt:   now,
  };

  const list = readProjects();
  list.push(project);
  writeProjects(list);

  // Initialize layers and annotations
  localStorage.setItem(LAYERS_KEY(project.id), JSON.stringify(defaultLayers(project.id)));
  localStorage.setItem(ANNOTS_KEY(project.id), JSON.stringify(defaultAnnotations(project.id)));

  return project;
}

export type UpdateProjectInput = Partial<{
  name:        string;
  description: string;
  preset:      string;
  scaleValue:  number;
  scaleUnit:   string;
  scalePixels: number;
  status:      ProjectStatus;
  imageUrl:    string;
  lineArtUrl:  string;
  lineArtSvg:  string;
}>;

export function dbUpdateProject(id: number, data: UpdateProjectInput): Project {
  const list = readProjects();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) throw new Error(`Project ${id} not found`);

  const updated: Project = {
    ...list[idx],
    ...data,
    updatedAt: new Date().toISOString(),
  } as Project;

  list[idx] = updated;
  writeProjects(list);
  return updated;
}

export function dbDeleteProject(id: number): void {
  const list = readProjects().filter(p => p.id !== id);
  writeProjects(list);
  localStorage.removeItem(LAYERS_KEY(id));
  localStorage.removeItem(ANNOTS_KEY(id));
}

export function dbGetStats(): ProjectStats {
  const projects = readProjects();
  const byPreset: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const p of projects) {
    byPreset[p.preset] = (byPreset[p.preset] ?? 0) + 1;
    byStatus[p.status ?? "empty"] = (byStatus[p.status ?? "empty"] ?? 0) + 1;
  }
  const recentProjects = [...projects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);
  return { totalProjects: projects.length, byPreset, byStatus, recentProjects };
}

// ── レイヤー ────────────────────────────────────────────────────────────────

export function dbGetLayers(projectId: number): LayerConfig {
  try {
    const raw = localStorage.getItem(LAYERS_KEY(projectId));
    if (raw) return JSON.parse(raw) as LayerConfig;
  } catch { /* fall through */ }
  return defaultLayers(projectId);
}

export function dbUpdateLayers(projectId: number, layers: LayerInfo[]): LayerConfig {
  const config: LayerConfig = { projectId, layers };
  localStorage.setItem(LAYERS_KEY(projectId), JSON.stringify(config));
  return config;
}

// ── アノテーション ──────────────────────────────────────────────────────────

export function dbGetAnnotations(projectId: number): AnnotationData {
  try {
    const raw = localStorage.getItem(ANNOTS_KEY(projectId));
    if (raw) return JSON.parse(raw) as AnnotationData;
  } catch { /* fall through */ }
  return defaultAnnotations(projectId);
}

export function dbSaveAnnotations(projectId: number, data: Pick<AnnotationData, "strokes" | "textAnnotations">): AnnotationData {
  const saved: AnnotationData = { projectId, ...data };
  localStorage.setItem(ANNOTS_KEY(projectId), JSON.stringify(saved));
  return saved;
}
