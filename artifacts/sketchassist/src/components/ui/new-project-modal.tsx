import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateProject, ProjectInputPreset } from "@/lib/use-projects";
import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";

const formSchema = z.object({
  name: z.string().min(1, "プロジェクト名を入力してください").max(100),
  description: z.string().optional(),
  preset: z.nativeEnum(ProjectInputPreset)
});

interface NewProjectModalProps {
  children: React.ReactNode;
}

export function NewProjectModal({ children }: NewProjectModalProps) {
  const [open, setOpen] = useState(false);
  const [confidential, setConfidential] = useState(false);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createProject = useCreateProject();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      description: "",
      preset: ProjectInputPreset.insect,
    },
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    const data = confidential
      ? { ...values, description: values.description ? `【機密】${values.description}` : "【機密】" }
      : values;
    createProject.mutate(
      { data },
      {
        onSuccess: (project) => {
          toast({ title: "プロジェクトを作成しました" });
          setOpen(false);
          form.reset();
          setLocation(`/project/${project.id}`);
        },
        onError: () => {
          toast({ title: "エラー", description: "プロジェクトの作成に失敗しました", variant: "destructive" });
        }
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px] border-border bg-card">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">プロジェクトを作成</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            新しい研究プロジェクトを開始します。
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-1">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">プロジェクト名</FormLabel>
                  <FormControl>
                    <Input placeholder="例：甲虫標本 A-001" className="bg-background" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="preset"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">種別</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="bg-background">
                        <SelectValue placeholder="種別を選択" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={ProjectInputPreset.insect}>昆虫モード</SelectItem>
                      <SelectItem value={ProjectInputPreset.artifact}>考古遺物モード</SelectItem>
                      <SelectItem value={ProjectInputPreset.fossil}>化石モード</SelectItem>
                      <SelectItem value={ProjectInputPreset.plant}>植物モード</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-muted-foreground">メモ（任意）</FormLabel>
                  <FormControl>
                    <Input placeholder="例：左後翅の初期スキャン" className="bg-background" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 機密資料チェック */}
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <Checkbox
                id="confidential"
                checked={confidential}
                onCheckedChange={(v) => setConfidential(!!v)}
                className="mt-0.5"
              />
              <label htmlFor="confidential" className="flex-1 cursor-pointer">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <ShieldCheck className="w-3 h-3 text-muted-foreground" />
                  <span className="text-sm font-medium">機密資料として扱う</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  プロジェクト名に【機密】を付加します。処理はすべてローカルで完結します。
                </p>
              </label>
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                キャンセル
              </Button>
              <Button
                type="submit"
                disabled={createProject.isPending}
              >
                {createProject.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                作成する
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
