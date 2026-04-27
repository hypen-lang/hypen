import { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  FolderTree,
  Eye,
  Database,
  Activity,
  Terminal,
  SquareTerminal,
  Clock,
  Save,
  RefreshCw,
  Layout,
  Search,
  LayoutGrid,
  Rocket,
} from "lucide-react";
import type { PanelState } from "./Studio";

type Command = {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string[];
  action: () => void;
  category?: string;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  panels: PanelState;
  togglePanel: (panel: keyof PanelState) => void;
  onSave: () => void;
  onOpenTestMode: () => void;
  onRun: () => void;
};

export function CommandPalette({
  open,
  onClose,
  panels,
  togglePanel,
  onSave,
  onOpenTestMode,
  onRun,
}: CommandPaletteProps) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const commands: Command[] = useMemo(
    () => [
      {
        id: "toggle-files",
        label: "Toggle Files Panel",
        icon: <FolderTree className="w-4 h-4" />,
        shortcut: ["⌘", "B"],
        action: () => togglePanel("files"),
        category: "Panels",
      },
      {
        id: "toggle-preview",
        label: "Toggle Preview",
        icon: <Eye className="w-4 h-4" />,
        shortcut: ["⌘", "P"],
        action: () => togglePanel("preview"),
        category: "Panels",
      },
      {
        id: "toggle-state",
        label: "Toggle State Inspector",
        icon: <Database className="w-4 h-4" />,
        shortcut: ["⌘", "⇧", "S"],
        action: () => togglePanel("state"),
        category: "Panels",
      },
      {
        id: "toggle-actions",
        label: "Toggle Action Log",
        icon: <Activity className="w-4 h-4" />,
        shortcut: ["⌘", "A"],
        action: () => togglePanel("actions"),
        category: "Panels",
      },
      {
        id: "toggle-console",
        label: "Toggle Console",
        icon: <Terminal className="w-4 h-4" />,
        shortcut: ["⌘", "J"],
        action: () => togglePanel("console"),
        category: "Panels",
      },
      {
        id: "toggle-timeline",
        label: "Toggle Timeline",
        icon: <Clock className="w-4 h-4" />,
        shortcut: ["⌘", "⇧", "T"],
        action: () => togglePanel("timeline"),
        category: "Panels",
      },
      {
        id: "toggle-terminal",
        label: "Toggle Terminal",
        icon: <SquareTerminal className="w-4 h-4" />,
        shortcut: ["⌘", "T"],
        action: () => togglePanel("terminal"),
        category: "Panels",
      },
      {
        id: "save-file",
        label: "Save File",
        icon: <Save className="w-4 h-4" />,
        shortcut: ["⌘", "S"],
        action: onSave,
        category: "File",
      },
      {
        id: "refresh-preview",
        label: "Refresh Preview",
        icon: <RefreshCw className="w-4 h-4" />,
        shortcut: ["⌘", "R"],
        action: () => {
          // Trigger refresh
        },
        category: "Preview",
      },
      {
        id: "reset-layout",
        label: "Reset Layout",
        icon: <Layout className="w-4 h-4" />,
        action: () => {
          togglePanel("files");
          togglePanel("preview");
        },
        category: "View",
      },
      {
        id: "open-test-mode",
        label: "Open Test Mode (new window)",
        icon: <LayoutGrid className="w-4 h-4" />,
        action: onOpenTestMode,
        category: "Run",
      },
      {
        id: "run",
        label: "Run on Device…",
        icon: <Rocket className="w-4 h-4" />,
        action: onRun,
        category: "Run",
      },
    ],
    [togglePanel, onSave, onOpenTestMode, onRun]
  );

  const filteredCommands = useMemo(() => {
    if (!search) return commands;
    const lower = search.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lower) ||
        cmd.category?.toLowerCase().includes(lower)
    );
  }, [commands, search]);

  // Reset selected index when filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length]);

  // Reset search when closed
  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedIndex(0);
    }
  }, [open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filteredCommands[selectedIndex];
        if (cmd) {
          cmd.action();
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, filteredCommands, selectedIndex, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Type a command..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 py-4 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground"
            autoFocus
          />
        </div>

        {/* Commands List */}
        <div className="max-h-80 overflow-y-auto p-2">
          {filteredCommands.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-sm">
              No commands found
            </div>
          ) : (
            filteredCommands.map((cmd, index) => (
              <button
                key={cmd.id}
                className={cn(
                  "w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg",
                  "transition-colors",
                  index === selectedIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                )}
                onClick={() => {
                  cmd.action();
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">{cmd.icon}</span>
                  <span>{cmd.label}</span>
                </div>

                {cmd.shortcut && (
                  <div className="flex items-center gap-1">
                    {cmd.shortcut.map((key, i) => (
                      <kbd
                        key={i}
                        className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-xs font-mono"
                      >
                        {key}
                      </kbd>
                    ))}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
