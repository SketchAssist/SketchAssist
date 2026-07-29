import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useGetProject, useExportProject, ExportOptionsFormat } from "@/lib/use-projects";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Download, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

export default function Export() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: project, isLoading } = useGetProject(id, { query: { enabled: !!id, queryKey: ['getProject', id] } });
  const exportProject = useExportProject();

  const [format, setFormat] = useState<ExportOptionsFormat>(ExportOptionsFormat.svg);
  const [includeLineart, setIncludeLineart] = useState(true);
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [includeOriginal, setIncludeOriginal] = useState(false);
  const [includeScaleBar, setIncludeScaleBar] = useState(true);
  const [dpi, setDpi] = useState("300");

  if (isLoading) {
    return (
      <Layout>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!project) {
    return (
      <Layout>
        <div className="flex h-full items-center justify-center flex-col gap-4">
          <h2 className="font-mono text-xl">Workspace Not Found</h2>
          <Button onClick={() => setLocation("/")} variant="outline" className="font-mono">
            <ArrowLeft className="w-4 h-4 mr-2" /> Return to Control
          </Button>
        </div>
      </Layout>
    );
  }

  const handleExport = () => {
    const layers = [];
    if (includeLineart) layers.push("lineart");
    if (includeAnnotations) layers.push("annotation");
    if (includeOriginal) layers.push("original");

    exportProject.mutate({
      id,
      data: {
        format,
        includeLayers: layers as any[],
        includeScaleBar,
        dpi: parseInt(dpi, 10)
      }
    }, {
      onSuccess: (result) => {
        toast({
          title: "Export Complete",
          description: `File ready: ${result.fileUrl} (${(result.fileSizeBytes! / 1024).toFixed(1)} KB)`
        });
        // In a real app, we'd trigger a download here
        const a = document.createElement("a");
        a.href = result.fileUrl;
        a.download = `sketchassist_${project.name}_export.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      },
      onError: () => {
        toast({
          title: "Export Failed",
          description: "An error occurred during rendering.",
          variant: "destructive"
        });
      }
    });
  };

  return (
    <Layout>
      <div className="flex flex-col h-full bg-background overflow-hidden">
        {/* Top Header */}
        <header className="h-14 border-b border-border flex items-center px-4 shrink-0 bg-card">
          <Button variant="ghost" size="sm" onClick={() => setLocation(`/project/${id}`)} className="text-muted-foreground hover:text-foreground font-mono mr-4">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Workspace
          </Button>
          <div className="h-6 w-px bg-border mx-2"></div>
          <h1 className="font-mono text-sm font-semibold ml-2">Export Configuration: {project.name}</h1>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
            
            <div className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="font-mono text-lg flex items-center gap-2">
                    <FileText className="w-5 h-5 text-primary" />
                    Output Format
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">Select vector or raster output format</CardDescription>
                </CardHeader>
                <CardContent>
                  {/*
                    PDF/EPS書き出しは未実装(現状生成できるのはSVGのみ)。
                    選択自体をできないようにし、拡張子と中身が食い違う
                    ファイルを生成しないようにする。実装され次第disabledを外すこと。
                  */}
                  <RadioGroup value={format} onValueChange={(v) => setFormat(v as ExportOptionsFormat)} className="grid grid-cols-3 gap-4">
                    <div>
                      <RadioGroupItem value="svg" id="svg" className="peer sr-only" />
                      <Label
                        htmlFor="svg"
                        className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer font-mono"
                      >
                        <FileText className="mb-3 h-6 w-6" />
                        SVG
                        <span className="text-[9px] mt-1 text-muted-foreground text-center">Scalable Vector Graphics</span>
                      </Label>
                    </div>
                    <div>
                      <RadioGroupItem value="pdf" id="pdf" className="peer sr-only" disabled />
                      <Label
                        htmlFor="pdf"
                        className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 opacity-40 cursor-not-allowed font-mono"
                      >
                        <FileText className="mb-3 h-6 w-6" />
                        PDF
                        <span className="text-[9px] mt-1 text-muted-foreground text-center">近日対応予定</span>
                      </Label>
                    </div>
                    <div>
                      <RadioGroupItem value="eps" id="eps" className="peer sr-only" disabled />
                      <Label
                        htmlFor="eps"
                        className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 opacity-40 cursor-not-allowed font-mono"
                      >
                        <FileText className="mb-3 h-6 w-6" />
                        EPS
                        <span className="text-[9px] mt-1 text-muted-foreground text-center">近日対応予定</span>
                      </Label>
                    </div>
                  </RadioGroup>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="font-mono text-lg">Layer Composition</CardTitle>
                  <CardDescription className="font-mono text-xs">Include or exclude specific data layers</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center space-x-2 p-3 border border-border rounded-md bg-accent/20">
                    <Checkbox id="l-lineart" checked={includeLineart} onCheckedChange={(c) => setIncludeLineart(!!c)} />
                    <Label htmlFor="l-lineart" className="flex-1 font-mono text-sm cursor-pointer">Processed Line Art</Label>
                  </div>
                  <div className="flex items-center space-x-2 p-3 border border-border rounded-md bg-accent/20">
                    <Checkbox id="l-annot" checked={includeAnnotations} onCheckedChange={(c) => setIncludeAnnotations(!!c)} />
                    <Label htmlFor="l-annot" className="flex-1 font-mono text-sm cursor-pointer">Hand-drawn Annotations</Label>
                  </div>
                  <div className="flex items-center space-x-2 p-3 border border-border rounded-md bg-accent/20">
                    <Checkbox id="l-scale" checked={includeScaleBar} onCheckedChange={(c) => setIncludeScaleBar(!!c)} disabled={!project.scaleValue} />
                    <Label htmlFor="l-scale" className="flex-1 font-mono text-sm cursor-pointer">Scale Bar Indicator</Label>
                    {!project.scaleValue && <span className="text-[10px] font-mono text-muted-foreground">Not set</span>}
                  </div>
                  <div className="flex items-center space-x-2 p-3 border border-border rounded-md bg-accent/20 opacity-70">
                    <Checkbox id="l-orig" checked={includeOriginal} onCheckedChange={(c) => setIncludeOriginal(!!c)} />
                    <Label htmlFor="l-orig" className="flex-1 font-mono text-sm cursor-pointer">Original Source Media (Raster)</Label>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="font-mono text-lg">Print Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Resolution (DPI)</Label>
                    <Select value={dpi} onValueChange={setDpi}>
                      <SelectTrigger className="font-mono">
                        <SelectValue placeholder="Select DPI" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="72">72 DPI (Web)</SelectItem>
                        <SelectItem value="150">150 DPI (Draft Print)</SelectItem>
                        <SelectItem value="300">300 DPI (Publication Quality)</SelectItem>
                        <SelectItem value="600">600 DPI (High Fidelity)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border h-48 flex flex-col">
                <CardHeader className="pb-2">
                  <CardTitle className="font-mono text-lg">Export Summary</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-center items-center text-center p-6 bg-accent/10 m-4 rounded border border-dashed border-border mt-0">
                  <ImageIcon className="w-8 h-8 text-muted-foreground mb-2" />
                  {/* 実データがない項目を架空の数値で埋めない。解像度・容量は
                      出力後まで確定しないため、分かっている事実(フォーマット・
                      DPI設定)のみを表示する。 */}
                  <p className="font-mono text-sm">Format: {format.toUpperCase()} @ {dpi} DPI</p>
                  <p className="font-mono text-xs text-muted-foreground mt-1">
                    {project.lineArtSvg
                      ? "Line art is ready to export."
                      : "Line art has not been generated yet."}
                  </p>
                </CardContent>
              </Card>

              {!project.lineArtSvg && (
                <p className="font-mono text-xs text-destructive text-center">
                  まだ書き出し用データがありません。エディター画面で写真を読み込み、
                  「エクスポート」ボタンを押すと、その時点の手書き修正キャンバスの内容が
                  自動的に保存されます(先にエディターへ戻って画像を読み込んでください)。
                </p>
              )}

              <Button 
                size="lg" 
                className="w-full font-mono text-base h-14 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleExport}
                disabled={exportProject.isPending || !project.lineArtSvg || format !== "svg"}
              >
                {exportProject.isPending ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <Download className="mr-2 h-5 w-5" />
                )}
                {exportProject.isPending ? "Rendering..." : "Generate Final Asset"}
              </Button>
            </div>
            
          </div>
        </div>
      </div>
    </Layout>
  );
}
