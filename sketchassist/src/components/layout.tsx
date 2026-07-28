import { Link, useLocation } from "wouter";
import { Image as ImageIcon, PanelLeftClose, PanelLeftOpen, Sun, Moon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { isDark, toggle } = useTheme();

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <div
        className={`flex flex-col bg-sidebar border-r border-border transition-all duration-300 ease-in-out ${
          sidebarOpen ? "w-56" : "w-14"
        }`}
      >
        {/* Logo */}
        <div className="flex items-center h-14 px-4 border-b border-border shrink-0">
          {sidebarOpen ? (
            <Link href="/" className="flex items-center gap-2.5 text-primary font-semibold text-[15px] tracking-tight">
              <SketchIcon className="w-5 h-5 shrink-0" />
              <span>SketchAssist</span>
            </Link>
          ) : (
            <Link href="/" className="flex items-center justify-center w-full text-primary">
              <SketchIcon className="w-5 h-5" />
            </Link>
          )}
        </div>

        {/* Nav */}
        <div className="flex-1 py-3 flex flex-col gap-1 overflow-y-auto">
          <NavItem
            href="/"
            icon={<ImageIcon className="w-4 h-4" />}
            label="プロジェクト"
            active={location === "/"}
            expanded={sidebarOpen}
          />

        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border shrink-0 flex flex-col gap-1">
          {/* Offline badge */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className={`flex items-center h-8 px-2 rounded-md gap-2 cursor-default select-none ${
                sidebarOpen ? "" : "justify-center"
              }`}>
                <span className="flex items-center gap-1.5 text-[10px] text-green-600 dark:text-green-400 font-medium">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  {sidebarOpen && "ローカル処理"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[200px] text-xs leading-relaxed">
              すべての処理は端末内で完結します。画像データは外部サーバーに一切送信されません。
            </TooltipContent>
          </Tooltip>

          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="icon"
            className={`w-full h-9 ${sidebarOpen ? "justify-start px-2 gap-2" : "justify-center"} text-muted-foreground hover:text-foreground`}
            onClick={toggle}
            title={isDark ? "ライトモードに切り替え" : "ダークモードに切り替え"}
          >
            {isDark ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
            {sidebarOpen && <span className="text-sm">{isDark ? "ライトモード" : "ダークモード"}</span>}
          </Button>

          {/* Collapse */}
          <Button
            variant="ghost"
            size="icon"
            className={`w-full h-9 ${sidebarOpen ? "justify-start px-2 gap-2" : "justify-center"} text-muted-foreground hover:text-foreground`}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? (
              <>
                <PanelLeftClose className="w-4 h-4 shrink-0" />
                <span className="text-sm">折りたたむ</span>
              </>
            ) : (
              <PanelLeftOpen className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function NavItem({ href, icon, label, active, expanded }: {
  href: string; icon: React.ReactNode; label: string; active: boolean; expanded: boolean;
}) {
  return (
    <Link href={href}>
      <div className={`flex items-center gap-3 h-9 px-3 mx-1 rounded-md cursor-pointer transition-colors text-sm ${
        active
          ? "bg-primary/10 text-primary font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      } ${expanded ? "" : "justify-center px-0 mx-0"}`}>
        {icon}
        {expanded && <span>{label}</span>}
      </div>
    </Link>
  );
}

function SketchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 19c-4 0-7-3-7-7s3-7 7-7 7 3 7 7" />
      <path d="M12 5v2M5.5 7.5l1.4 1.4M19 12h-2" />
      <path d="M15 15l3 3" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}
