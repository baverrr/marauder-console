import { type ComponentType, type ReactNode } from "react";
import {
  BookOpen,
  SlidersHorizontal,
  HelpCircle,
  Microscope,
  History,
  FolderOpen,
  MapPin,
  Radar,
  Bot,
} from "lucide-react";
import { CATEGORIES, TOOLS_BY_CATEGORY, type CategoryId } from "@/tools";
import { CATEGORY_ICONS } from "@/components/icons";
import { cn } from "@/lib/utils";

export type View = "reference" | "control" | "analysis" | "assistant";

/** PC-side analysis views (Phase 3). */
export type AnalysisId = "history" | "captures" | "map" | "findmy";

export const ANALYSIS_VIEWS: { id: AnalysisId; name: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: "findmy", name: "Find My radar", icon: Radar },
  { id: "captures", name: "Capture library", icon: FolderOpen },
  { id: "map", name: "Wardrive map", icon: MapPin },
  { id: "history", name: "Session history", icon: History },
];

interface Props {
  view: View;
  onView: (v: View) => void;
  active: CategoryId | "hardware";
  onSelect: (id: CategoryId | "hardware") => void;
  analysisActive: AnalysisId;
  onAnalysisSelect: (id: AnalysisId) => void;
}

export function CategoryNav({ view, onView, active, onSelect, analysisActive, onAnalysisSelect }: Props) {
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-4 border-r border-border bg-card/40 p-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-background/40 p-1">
        <ModeButton active={view === "reference"} onClick={() => onView("reference")} icon={<BookOpen />}>
          Reference
        </ModeButton>
        <ModeButton active={view === "control"} onClick={() => onView("control")} icon={<SlidersHorizontal />}>
          Control
        </ModeButton>
        <ModeButton active={view === "analysis"} onClick={() => onView("analysis")} icon={<Microscope />}>
          Analysis
        </ModeButton>
        <ModeButton active={view === "assistant"} onClick={() => onView("assistant")} icon={<Bot />}>
          Assistant
        </ModeButton>
      </div>

      {view === "assistant" ? (
        <div className="px-2 text-xs text-muted-foreground">
          Claude advises and drafts commands; you review and run them.
        </div>
      ) : view === "analysis" ? (
        <div className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            PC-side analysis
          </p>
          {ANALYSIS_VIEWS.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.id}
                onClick={() => onAnalysisSelect(a.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                  analysisActive === a.id
                    ? "bg-primary/15 text-primary"
                    : "text-foreground/80 hover:bg-secondary/60",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="flex-1 text-left">{a.name}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Categories
            </p>
            {CATEGORIES.map((c) => {
              const Icon = CATEGORY_ICONS[c.icon];
              const count = TOOLS_BY_CATEGORY[c.id].length;
              return (
                <button
                  key={c.id}
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                    active === c.id ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-secondary/60",
                  )}
                >
                  {Icon && <Icon className="size-4 shrink-0" />}
                  <span className="flex-1 text-left">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-auto">
            <button
              onClick={() => onSelect("hardware")}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                active === "hardware" ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-secondary/60",
              )}
            >
              <HelpCircle className="size-4 shrink-0" />
              <span className="flex-1 text-left">Hardware &amp; setup</span>
            </button>
          </div>
        </>
      )}
    </nav>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
