/**
 * use-projects.ts
 * React Query フック群 — @workspace/api-client-react の完全代替。
 * データは local-db.ts (localStorage) に保存する。
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  dbListProjects,
  dbGetProject,
  dbCreateProject,
  dbUpdateProject,
  dbDeleteProject,
  dbGetStats,
  dbGetLayers,
  dbUpdateLayers,
  dbGetAnnotations,
  dbSaveAnnotations,
  type CreateProjectInput,
  type UpdateProjectInput,
  type LayerInfo,
  type AnnotationData,
} from "./local-db";

// ── クエリキーヘルパー（editor.tsx / dashboard.tsx が invalidate に使用）─────

export const getListProjectsQueryKey     = ()           => ["projects"] as const;
export const getGetProjectStatsQueryKey  = ()           => ["stats"] as const;
export const getGetProjectQueryKey       = (id: number) => ["project", id] as const;
export const getGetLayersQueryKey        = (id: number) => ["layers", id] as const;
export const getGetAnnotationsQueryKey   = (id: number) => ["annotations", id] as const;

/** React Query の queryKey は readonly を受け入れるため、any[] を想定する箇所向けのキャスト */
type QK = readonly unknown[];

// ── 読み取りフック ──────────────────────────────────────────────────────────

export function useListProjects() {
  return useQuery({
    queryKey: getListProjectsQueryKey(),
    queryFn:  () => dbListProjects(),
  });
}

export function useGetProjectStats() {
  return useQuery({
    queryKey: getGetProjectStatsQueryKey(),
    queryFn:  () => dbGetStats(),
  });
}

export function useGetProject(
  id: number,
  options?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
) {
  return useQuery({
    queryKey: options?.query?.queryKey ?? getGetProjectQueryKey(id),
    queryFn:  () => {
      const p = dbGetProject(id);
      if (!p) throw new Error(`Project ${id} not found`);
      return p;
    },
    enabled: options?.query?.enabled ?? true,
  });
}

export function useGetLayers(
  id: number,
  options?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
) {
  return useQuery({
    queryKey: options?.query?.queryKey ?? getGetLayersQueryKey(id),
    queryFn:  () => dbGetLayers(id),
    enabled:  options?.query?.enabled ?? true,
  });
}

export function useGetAnnotations(
  id: number,
  options?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
) {
  return useQuery({
    queryKey: options?.query?.queryKey ?? getGetAnnotationsQueryKey(id),
    queryFn:  () => dbGetAnnotations(id),
    enabled:  options?.query?.enabled ?? true,
  });
}

// ── 書き込みフック ──────────────────────────────────────────────────────────

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ data }: { data: CreateProjectInput }) => {
      const project = dbCreateProject(data);
      return Promise.resolve(project);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetProjectStatsQueryKey() });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) => {
      dbDeleteProject(id);
      return Promise.resolve();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetProjectStatsQueryKey() });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateProjectInput }) => {
      const project = dbUpdateProject(id, data);
      return Promise.resolve(project);
    },
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetProjectStatsQueryKey() });
    },
  });
}

export function useUpdateLayers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { layers: LayerInfo[] } }) => {
      const config = dbUpdateLayers(id, data.layers);
      return Promise.resolve(config);
    },
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: getGetLayersQueryKey(id) });
    },
  });
}

export function useSaveAnnotations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Pick<AnnotationData, "projectId" | "strokes" | "textAnnotations">;
    }) => {
      const saved = dbSaveAnnotations(id, {
        strokes:         data.strokes,
        textAnnotations: data.textAnnotations,
      });
      return Promise.resolve(saved);
    },
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: getGetAnnotationsQueryKey(id) });
    },
  });
}

/** クライアントサイド SVG エクスポート（api-server の useExportProject 代替）*/
export function useExportProject() {
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: number;
      data: { format: string; includeLayers?: string[]; dpi?: number; includeScaleBar?: boolean };
    }) => {
      const project = dbGetProject(id);
      if (!project) throw new Error(`Project ${id} not found`);

      const svg = project.lineArtSvg;
      if (!svg) throw new Error("SVG データがまだ生成されていません。パイプラインを完了してください。");

      const blob = new Blob([svg], { type: "image/svg+xml" });
      const fileUrl = URL.createObjectURL(blob);
      return { fileUrl, fileSizeBytes: blob.size, format: data.format };
    },
  });
}

// ── 型の再エクスポート（各ページが @workspace/api-client-react から import していたもの）─

export type {
  Project,
  LayerInfo,
  LayerConfig,
  AnnotationData,
  Stroke,
  TextAnnotation,
  ProjectStats,
} from "./local-db";

export {
  ProjectInputPreset,
  LayerInfoType,
  StrokeTool,
  TextAnnotationKind,
} from "./local-db";

/** @workspace/api-client-react の ExportOptionsFormat 互換 */
export type ExportOptionsFormat = typeof ExportOptionsFormat[keyof typeof ExportOptionsFormat];
export const ExportOptionsFormat = {
  svg: "svg",
  pdf: "pdf",
  eps: "eps",
  png: "png",
} as const;
