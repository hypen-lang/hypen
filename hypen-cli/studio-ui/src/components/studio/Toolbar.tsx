import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  FolderTree,
  Eye,
  Database,
  Activity,
  SquareTerminal,
  ScrollText,
  Clock,
  Command,
  LayoutGrid,
} from "lucide-react";
import type { PanelState } from "./Studio";
import { RunNativeMenu } from "./RunNativeMenu";

type ToolbarProps = {
  panels: PanelState;
  togglePanel: (panel: keyof PanelState) => void;
  connected: boolean;
  onOpenTestMode: () => void;
  onCommandPalette: () => void;
};

export function Toolbar({ panels, togglePanel, connected, onOpenTestMode, onCommandPalette }: ToolbarProps) {
  const iconBtn = "h-8 w-8 p-0";
  return (
    <div className="h-12 border-b border-border bg-card flex items-center px-4 gap-2 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-3 mr-4">
        <span className="text-lg font-mono font-medium tracking-tight">
          <span className="text-[#FFA7E1]">hypen</span>
          <span className="text-muted-foreground"> studio</span>
        </span>
        <div
          className={cn(
            "px-2 py-0.5 text-xs font-mono rounded-lg border",
            connected
              ? "text-muted-foreground border-border"
              : "text-red-400 border-red-400/30"
          )}
        >
          {connected ? "connected" : "disconnected"}
        </div>
      </div>

      <div className="flex-1" />

      {/* All panel toggles right-aligned in original order. Icon-only panels
          show full name + shortcut on hover via `title`. Preview + Test keep
          their labels because they're the primary reach targets. */}
      <div className="flex items-center gap-1">
        <Button
          variant={panels.files ? "secondary" : "ghost"}
          size="sm"
          onClick={() => togglePanel("files")}
          className={iconBtn}
          title="Files (⌘B)"
          aria-label="Files"
        >
          <FolderTree className="w-4 h-4" />
        </Button>

        <Button
          variant={panels.state ? "secondary" : "ghost"}
          size="sm"
          onClick={() => togglePanel("state")}
          className={iconBtn}
          title="State"
          aria-label="State"
        >
          <Database className="w-4 h-4" />
        </Button>

        <Button
          variant={panels.actions ? "secondary" : "ghost"}
          size="sm"
          onClick={() => togglePanel("actions")}
          className={iconBtn}
          title="Actions"
          aria-label="Actions"
        >
          <Activity className="w-4 h-4" />
        </Button>

        <Button
          variant={panels.console ? "secondary" : "ghost"}
          size="sm"
          onClick={() => togglePanel("console")}
          className={iconBtn}
          title="Console (⌘J)"
          aria-label="Console"
        >
          <ScrollText className="w-4 h-4" />
        </Button>

        <Button
          variant={panels.timeline ? "secondary" : "ghost"}
          size="sm"
          onClick={() => togglePanel("timeline")}
          className={iconBtn}
          title="Timeline"
          aria-label="Timeline"
        >
          <Clock className="w-4 h-4" />
        </Button>

        <Button
          variant={panels.terminal ? "secondary" : "ghost"}
          size="sm"
          onClick={() => togglePanel("terminal")}
          className={iconBtn}
          title="Terminal (⌘T)"
          aria-label="Terminal"
        >
          <SquareTerminal className="w-4 h-4" />
        </Button>
      </div>

      {/* Divider between "what to inspect" and "what to run". */}
      <div className="w-px h-6 bg-border mx-2" />

      {/* Primary action group: Preview, Test Mode, Run. */}
      <div className="flex items-center gap-1">
        <Button
          variant={panels.preview ? "secondary" : "ghost"}
          size="sm"
          onClick={() => togglePanel("preview")}
          className="gap-1.5"
          title="Preview"
        >
          <Eye className="w-4 h-4" />
          <span className="hidden sm:inline">Preview</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenTestMode}
          className="gap-1.5"
          title="Test Mode — opens in a new window: tile multiple previews and device mirrors"
        >
          <LayoutGrid className="w-4 h-4" />
          <span className="hidden sm:inline">Test</span>
        </Button>

        <RunNativeMenu />
      </div>

      <div className="w-px h-6 bg-border mx-2" />

      {/* Command Palette */}
      <Button
        variant="outline"
        size="sm"
        onClick={onCommandPalette}
        className="gap-1.5"
        title="Command Palette (⌘K)"
      >
        <Command className="w-4 h-4" />
        <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium">
          ⌘K
        </kbd>
      </Button>
    </div>
  );
}
