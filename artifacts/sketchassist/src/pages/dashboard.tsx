import { useListProjects, useGetProjectStats, useDeleteProject, getListProjectsQueryKey, getGetProjectStatsQueryKey } from "@/lib/use-projects";
import { useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Clock, Trash2, ArrowUpDown, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { NewProjectModal } from "@/components/new-project-modal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ── E: ソート定義 ──────────────────────────────────────────────
type SortKey = "updated" | "created" | "name";
const SORT_LABELS: Record<SortKey, string> = {
  updated: "更新日順",
  created: "作成日順",
  name: "名前順",
};

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { data: projects, isLoading: projectsLoading } = useListProjects();
  const { data: stats, isLoading: statsLoading } = useGetProjectStats();
  const deleteProject = useDeleteProject();

  // E: フィルター・ソート state
  const [filterPreset, setFilterPreset] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortKey>("updated");

  const handleDelete = async (id: number) => {
    await deleteProject.mutateAsync({ id });
    queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey() });
  };

  // E: フィルター + ソート適用
  const displayedProjects = useMemo(() => {
    if (!projects) return [];
    let list = [...projects];
    if (filterPreset !== "all") {
      list = list.filter(p => p.preset === filterPreset);
    }
    list.sort((a, b) => {
      if (sortBy === "name")    return a.name.localeCompare(b.name, "ja");
      if (sortBy === "created") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      /* updated */             return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return list;
  }, [projects, filterPreset, sortBy]);

  // プライバシーインフォバー（初回のみ）
  const [privacyDismissed, setPrivacyDismissed] = useState<boolean>(() =>
    localStorage.getItem("sketchassist-privacy-dismissed") === "1"
  );
  const dismissPrivacy = () => {
    localStorage.setItem("sketchassist-privacy-dismissed", "1");
    setPrivacyDismissed(true);
  };

  return (
    <Layout>
      <div className="h-full overflow-y-auto p-6 lg:p-8 max-w-7xl mx-auto w-full flex flex-col gap-8">

        {/* プライバシーインフォバー */}
        {!privacyDismissed && (
          <div className="flex items-start gap-3 bg-primary/5 border border-primary/20 rounded-xl px-4 py-3">
            <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <p className="flex-1 text-sm text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">すべての処理は端末内で完結します。</span>
              {" "}画像データは外部サーバーに一切送信されません。博物館・研究機関の機密資料にも安全にご利用いただけます。
            </p>
            <button
              onClick={dismissPrivacy}
              className="text-muted-foreground hover:text-foreground transition-colors mt-0.5 shrink-0"
              aria-label="閉じる"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">プロジェクト一覧</h1>
          </div>
          <NewProjectModal>
            <Button size="default">
              <Plus className="w-4 h-4 mr-2" />
              新しいプロジェクト
            </Button>
          </NewProjectModal>
        </div>

        {/* ── E: Stats v2 — カテゴリアイコン・カラーバー付き ─────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCardV2
            title="合計"
            desc="すべての種別"
            value={statsLoading ? null : stats?.totalProjects}
            icon={<TotalIcon />}
            color="primary"
            accent
          />
          <StatCardV2
            title="昆虫"
            desc="昆虫類"
            value={statsLoading ? null : stats?.byPreset?.insect || 0}
            icon={<InsectIcon />}
            color="amber"
            onClick={() => setFilterPreset(f => f === "insect" ? "all" : "insect")}
            active={filterPreset === "insect"}
          />
          <StatCardV2
            title="考古遺物"
            desc="遺物・土器"
            value={statsLoading ? null : stats?.byPreset?.artifact || 0}
            icon={<ArtifactIcon />}
            color="stone"
            onClick={() => setFilterPreset(f => f === "artifact" ? "all" : "artifact")}
            active={filterPreset === "artifact"}
          />
          <StatCardV2
            title="化石"
            desc="古生物・鉱物"
            value={statsLoading ? null : stats?.byPreset?.fossil || 0}
            icon={<FossilIcon />}
            color="orange"
            onClick={() => setFilterPreset(f => f === "fossil" ? "all" : "fossil")}
            active={filterPreset === "fossil"}
          />
          <StatCardV2
            title="植物"
            desc="植物・菌類"
            value={statsLoading ? null : stats?.byPreset?.plant || 0}
            icon={<PlantIcon />}
            color="green"
            onClick={() => setFilterPreset(f => f === "plant" ? "all" : "plant")}
            active={filterPreset === "plant"}
          />
        </div>

        {/* Project Grid */}
        <div className="flex flex-col gap-4">

          {/* ── E: フィルター・ソートバー ────────────────────────── */}
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <div className="flex items-center gap-1.5 flex-wrap">

              {(["all", "insect", "artifact", "fossil", "plant"] as const).map(key => (
                <button
                  key={key}
                  onClick={() => setFilterPreset(key)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    filterPreset === key
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {key === "all"      ? "すべて" :
                   key === "insect"   ? "昆虫" :
                   key === "artifact" ? "考古遺物" :
                   key === "fossil"   ? "化石" : "植物"}
                  {key !== "all" && projects && (
                    <span className="ml-1 opacity-60 font-mono text-[10px]">
                      {projects.filter(p => p.preset === key).length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground h-7 gap-1.5">
                  <ArrowUpDown className="w-3 h-3" />
                  {SORT_LABELS[sortBy]}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="text-sm">
                {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(([key, label]) => (
                  <DropdownMenuItem key={key} onClick={() => setSortBy(key)}
                    className={sortBy === key ? "text-primary font-medium" : ""}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {projectsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-48 w-full rounded-lg bg-card" />)}
            </div>
          ) : displayedProjects.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {displayedProjects.map((project) => (
                <ProjectCard key={project.id} project={project} onDelete={handleDelete} />
              ))}
            </div>
          ) : projects && projects.length > 0 ? (
            /* E: フィルター結果ゼロ状態 */
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm text-muted-foreground">
                「{filterPreset === "insect" ? "昆虫" : filterPreset === "artifact" ? "考古遺物" : filterPreset === "fossil" ? "化石" : "植物"}」のプロジェクトはまだありません。
              </p>
              <button
                className="mt-2 text-xs text-primary hover:underline"
                onClick={() => setFilterPreset("all")}
              >
                すべて表示
              </button>
            </div>
          ) : (
            /* ── E: 空状態 v2 — ワークフロー 3ステップガイド ─── */
            <div className="flex flex-col items-center justify-center py-16 px-8 border border-dashed border-border rounded-xl bg-card/40">
              <WorkflowEmptyState />
            </div>
          )}
        </div>

      </div>
    </Layout>
  );
}

// ══════════════════════════════════════════════════════════════
// E: StatCardV2 — カテゴリアイコン・上端カラーバー・補助ラベル
// ══════════════════════════════════════════════════════════════

type CardColor = "primary" | "amber" | "stone" | "orange" | "green";

const COLOR_MAP: Record<CardColor, { bar: string; icon: string; ring: string }> = {
  primary: { bar: "bg-primary",           icon: "text-primary",           ring: "ring-primary/30" },
  amber:   { bar: "bg-amber-500",          icon: "text-amber-600 dark:text-amber-400",  ring: "ring-amber-400/30" },
  stone:   { bar: "bg-stone-500",          icon: "text-stone-500 dark:text-stone-400",  ring: "ring-stone-400/30" },
  orange:  { bar: "bg-orange-500",         icon: "text-orange-600 dark:text-orange-400", ring: "ring-orange-400/30" },
  green:   { bar: "bg-emerald-600",        icon: "text-emerald-600 dark:text-emerald-400", ring: "ring-emerald-400/30" },
};

function StatCardV2({ title, desc, value, icon, color, accent, onClick, active }: {
  title: string;
  desc: string;
  value: number | null | undefined;
  icon: React.ReactNode;
  color: CardColor;
  accent?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  const c = COLOR_MAP[color];
  return (
    <div
      onClick={onClick}
      className={`relative rounded-lg border overflow-hidden transition-all select-none ${
        onClick ? "cursor-pointer" : ""
      } ${
        active
          ? `border-transparent ring-2 ${c.ring} bg-card`
          : accent
            ? "border-primary/20 bg-primary/5"
            : "border-border bg-card/60 hover:border-border/80"
      }`}
    >
      {/* 上端カラーバー */}
      <div className={`absolute top-0 left-0 right-0 h-[3px] ${c.bar}`} />

      <div className="pt-4 px-4 pb-3 flex flex-col gap-2">
        {/* アイコン + タイトル */}
        <div className="flex items-center justify-between">
          <span className={`text-xs font-medium text-muted-foreground`}>{title}</span>
          <span className={`${c.icon} opacity-70`}>{icon}</span>
        </div>

        {/* 数値 */}
        {value === null || value === undefined ? (
          <Skeleton className="h-7 w-12" />
        ) : (
          <div className={`text-2xl font-semibold font-mono ${accent ? "text-primary" : ""}`}>{value}</div>
        )}

        {/* 補助ラベル */}
        <p className="text-[10px] text-muted-foreground/60 leading-none">{desc}</p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// E: WorkflowEmptyState — 3ステップワークフローガイド
// ══════════════════════════════════════════════════════════════

function WorkflowEmptyState() {
  const steps = [
    {
      num: "1",
      title: "写真を読み込む",
      desc: "標本・遺物・化石の写真またはスキャン画像をプロジェクトに追加します。",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      ),
    },
    {
      num: "2",
      title: "処理ステップを実行",
      desc: "AI による輪郭抽出・構造解析・マスク生成を段階的に実行し、線画を生成します。",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
          <circle cx="12" cy="12" r="4" />
          <path d="M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      ),
    },
    {
      num: "3",
      title: "線画をエクスポート",
      desc: "生成した線画図版を SVG・PNG 形式でエクスポートし、論文や図版原稿に利用します。",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      ),
    },
  ];

  return (
    <div className="w-full max-w-2xl mx-auto py-4 flex flex-col items-center gap-8 text-center">
      {/* ロゴ的な上部 */}
      <div>
        <h3 className="text-lg font-semibold mb-1">SketchAssist へようこそ</h3>
        <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
          標本写真から研究用の線画図版を自動生成するツールです。
          まず最初のプロジェクトを作成してください。
        </p>
      </div>

      {/* 3ステップガイド */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full text-left">
        {steps.map((s, i) => (
          <div key={s.num} className="relative flex flex-col gap-3 p-4 rounded-lg bg-background border border-border">
            {/* コネクタ線（sm以上） */}
            {i < steps.length - 1 && (
              <div className="hidden sm:block absolute top-7 left-full w-4 border-t border-dashed border-border z-10 -translate-y-0.5" />
            )}
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                {s.icon}
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">STEP {s.num}</span>
            </div>
            <div>
              <p className="text-sm font-medium mb-1">{s.title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <NewProjectModal>
        <Button size="default">
          <Plus className="w-4 h-4 mr-2" />
          最初のプロジェクトを作成
        </Button>
      </NewProjectModal>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ラベル定数
// ══════════════════════════════════════════════════════════════

const PRESET_LABELS: Record<string, string> = {
  insect: "昆虫",
  artifact: "考古遺物",
  fossil: "化石",
  plant: "植物",
};

const STATUS_LABELS: Record<string, string> = {
  empty: "未処理",
  has_image: "写真あり",
  processed: "処理済み",
  annotated: "注釈済み",
};

// E: パイプライン進捗（ステータス → 0〜100%）
const STATUS_PROGRESS: Record<string, number> = {
  empty:      0,
  has_image:  25,
  processed:  70,
  annotated:  100,
};

// ══════════════════════════════════════════════════════════════
// ProjectCard
// ══════════════════════════════════════════════════════════════

function ProjectCard({ project, onDelete }: { project: any; onDelete: (id: number) => void }) {
  const getStatusStyle = (status: string) => {
    switch (status) {
      case "empty":     return "bg-muted text-muted-foreground";
      case "has_image": return "bg-blue-500/15 text-blue-500 border-blue-500/25";
      case "processed": return "bg-amber-500/15 text-amber-500 border-amber-500/25";
      case "annotated": return "bg-green-500/15 text-green-600 border-green-500/25";
      default:          return "bg-muted text-muted-foreground";
    }
  };

  // E: 進捗バーの色
  const getProgressColor = (status: string) => {
    switch (status) {
      case "has_image": return "bg-blue-500";
      case "processed": return "bg-amber-500";
      case "annotated": return "bg-green-500";
      default:          return "bg-muted-foreground/30";
    }
  };

  return (
    <div className="relative group">
      <Link href={`/project/${project.id}`}>
        <Card className="cursor-pointer hover:border-primary/40 transition-colors bg-card border-border overflow-hidden flex flex-col h-full">
          {/* Thumbnail */}
          <div className="aspect-video w-full bg-accent/50 relative overflow-hidden flex items-center justify-center">
            {project.imageUrl ? (
              <img src={project.imageUrl} alt={project.name}
                className="object-cover w-full h-full opacity-70 group-hover:opacity-100 transition-opacity" />
            ) : (
              <ImagePlaceholder />
            )}
            {project.lineArtUrl && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Badge variant="outline" className="bg-background/80 backdrop-blur text-xs border-primary/30">
                  線画あり
                </Badge>
              </div>
            )}
          </div>

          {/* Info */}
          <CardHeader className="p-4 pb-2">
            <div className="flex justify-between items-start gap-2">
              <CardTitle className="text-sm font-medium truncate" title={project.name}>
                {project.name}
              </CardTitle>
              <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                {PRESET_LABELS[project.preset] ?? project.preset}
              </Badge>
            </div>
            {project.description && (
              <CardDescription className="line-clamp-2 text-xs mt-1">
                {project.description}
              </CardDescription>
            )}
          </CardHeader>

          {/* ── E: パイプライン進捗バー + フッター ────────────────── */}
          <CardFooter className="p-4 pt-0 mt-auto flex flex-col gap-2">
            {/* 進捗バー */}
            <div className="w-full flex items-center gap-2">
              <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${getProgressColor(project.status)}`}
                  style={{ width: `${STATUS_PROGRESS[project.status] ?? 0}%` }}
                />
              </div>
              <span className="text-[9px] font-mono text-muted-foreground shrink-0 w-7 text-right">
                {STATUS_PROGRESS[project.status] ?? 0}%
              </span>
            </div>

            {/* ステータスバッジ + 日付 */}
            <div className="w-full flex items-center justify-between border-t border-border/50 pt-2">
              <Badge variant="secondary"
                className={`text-[10px] border ${getStatusStyle(project.status)}`}>
                {STATUS_LABELS[project.status] ?? project.status}
              </Badge>
              <div className="flex items-center text-xs text-muted-foreground gap-1">
                <Clock className="w-3 h-3" />
                {new Date(project.updatedAt).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}
              </div>
            </div>
          </CardFooter>
        </Card>
      </Link>

      {/* Delete button */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="destructive"
            size="icon"
            className="absolute top-2 right-2 w-7 h-7 opacity-0 group-hover:opacity-100 transition-opacity z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>プロジェクトを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{project.name}」を完全に削除します。レイヤー・アノテーション・処理済み線画もすべて失われます。この操作は元に戻せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDelete(project.id)}
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SVG アイコン群
// ══════════════════════════════════════════════════════════════

function ImagePlaceholder() {
  return (
    <svg viewBox="0 0 40 30" className="w-10 h-8 text-muted-foreground/25" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="1" width="38" height="28" rx="3" />
      <circle cx="13" cy="11" r="4" />
      <path d="m39 21-11-9L16 24l-5-5-10 10" />
    </svg>
  );
}

// E: StatCard v2 用カテゴリアイコン
function TotalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

function InsectIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <ellipse cx="8" cy="9" rx="3" ry="4" />
      <circle cx="8" cy="4" r="2" />
      <path d="M5 7 2 5M11 7l3-2M5 10 2 12M11 10l3 2M5 8.5 3 9M11 8.5l2 .5" />
    </svg>
  );
}

function ArtifactIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M3 13 5 3h6l2 10H3Z" />
      <path d="M5 7h6M6 10h4" />
    </svg>
  );
}

function FossilIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z" />
      <path d="M8 5v6M5 8h6" />
      <path d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5" strokeWidth="1" strokeOpacity="0.5" />
    </svg>
  );
}

function PlantIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M8 14V8" />
      <path d="M8 8C8 5 10 3 13 3c0 3-2 5-5 5Z" />
      <path d="M8 10C8 7 6 5 3 5c0 3 2 5 5 5Z" />
    </svg>
  );
}
