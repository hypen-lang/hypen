import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FileCode,
  FileJson,
  FileText,
  FilePlus,
  FolderPlus,
  Copy,
  Clipboard,
  Trash2,
  Pencil,
} from "lucide-react";
import type { FileNode } from "./Studio";

type FileTreeProps = {
  files: FileNode[];
  activeFile: string | null;
  selectedPath: string | null;
  clipboardPath: string | null;
  newItem: { type: "file" | "folder"; parentPath: string | null } | null;
  renamingPath: string | null;
  style?: React.CSSProperties;
  onFileSelect: (path: string) => void;
  onPathSelect: (path: string | null, isDirectory: boolean) => void;
  onNewFile: (parentPath: string | null) => void;
  onNewFolder: (parentPath: string | null) => void;
  onCreateItem: (name: string) => void;
  onCancelNewItem: () => void;
  onCopy: (path: string) => void;
  onPaste: (destinationPath: string | null) => void;
  onDelete: (path: string) => void;
  onRename: (path: string) => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
};

type ContextMenuState = {
  x: number;
  y: number;
  path: string;
  isDirectory: boolean;
} | null;

function getFileIcon(ext?: string) {
  switch (ext) {
    case ".hypen":
      return <FileCode className="w-4 h-4 text-pink-400" />;
    case ".ts":
    case ".tsx":
      return <FileCode className="w-4 h-4 text-blue-400" />;
    case ".js":
    case ".jsx":
      return <FileCode className="w-4 h-4 text-yellow-400" />;
    case ".json":
      return <FileJson className="w-4 h-4 text-green-400" />;
    case ".md":
      return <FileText className="w-4 h-4 text-gray-400" />;
    default:
      return <File className="w-4 h-4 text-muted-foreground" />;
  }
}

// Inline editable input for new items and rename
function InlineInput({
  defaultValue,
  onSubmit,
  onCancel,
  depth,
  icon,
}: {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  depth: number;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 bg-accent/50 rounded-sm"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      {icon}
      <input
        ref={inputRef}
        type="text"
        className="flex-1 bg-background border border-pink-500 rounded px-1.5 py-0.5 text-sm outline-none min-w-0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleSubmit();
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        onBlur={handleSubmit}
      />
    </div>
  );
}

function TreeItem({
  node,
  depth,
  activeFile,
  selectedPath,
  renamingPath,
  newItem,
  onFileSelect,
  onPathSelect,
  onNewFile,
  onContextMenu,
  onCreateItem,
  onCancelNewItem,
  onRenameSubmit,
  onCancelRename,
}: {
  node: FileNode;
  depth: number;
  activeFile: string | null;
  selectedPath: string | null;
  renamingPath: string | null;
  newItem: { type: "file" | "folder"; parentPath: string | null } | null;
  onFileSelect: (path: string) => void;
  onPathSelect: (path: string | null, isDirectory: boolean) => void;
  onNewFile: (parentPath: string | null) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDirectory: boolean) => void;
  onCreateItem: (name: string) => void;
  onCancelNewItem: () => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedPath === node.path;
  const isRenaming = renamingPath === node.path;
  const showNewItemHere = newItem && newItem.parentPath === node.path && node.type === "directory";

  if (node.type === "directory") {
    // Auto-expand when creating new item inside
    useEffect(() => {
      if (showNewItemHere && !expanded) {
        setExpanded(true);
      }
    }, [showNewItemHere]);

    return (
      <div>
        {isRenaming ? (
          <InlineInput
            defaultValue={node.name}
            onSubmit={(newName) => onRenameSubmit(node.path, newName)}
            onCancel={onCancelRename}
            depth={depth}
            icon={<Folder className="w-4 h-4 text-muted-foreground" />}
          />
        ) : (
          <div
            className={cn(
              "w-full flex items-center gap-1.5 px-2 py-1 hover:bg-accent/50 rounded-sm text-sm",
              "transition-colors cursor-pointer select-none group",
              isSelected && "bg-accent/70"
            )}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            onClick={(e) => {
              e.stopPropagation();
              onPathSelect(node.path, true);
              setExpanded(!expanded);
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(e, node.path, true);
            }}
          >
            <span
              className="flex items-center"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              )}
            </span>
            <Folder className="w-4 h-4 text-muted-foreground" />
            <span className="truncate flex-1">{node.name}</span>
            {hovered && (
              <span
                className="p-0.5 hover:bg-accent rounded opacity-60 hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewFile(node.path);
                }}
                title="New file in folder"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </span>
            )}
          </div>
        )}

        {expanded && (
          <div>
            {/* New item placeholder at the top of children */}
            {showNewItemHere && (
              <InlineInput
                defaultValue=""
                onSubmit={onCreateItem}
                onCancel={onCancelNewItem}
                depth={depth + 1}
                icon={
                  newItem.type === "folder" ? (
                    <Folder className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <File className="w-4 h-4 text-muted-foreground" />
                  )
                }
              />
            )}
            {node.children?.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                selectedPath={selectedPath}
                renamingPath={renamingPath}
                newItem={newItem}
                onFileSelect={onFileSelect}
                onPathSelect={onPathSelect}
                onNewFile={onNewFile}
                onContextMenu={onContextMenu}
                onCreateItem={onCreateItem}
                onCancelNewItem={onCancelNewItem}
                onRenameSubmit={onRenameSubmit}
                onCancelRename={onCancelRename}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isRenaming) {
    return (
      <InlineInput
        defaultValue={node.name}
        onSubmit={(newName) => onRenameSubmit(node.path, newName)}
        onCancel={onCancelRename}
        depth={depth}
        icon={getFileIcon(node.ext)}
      />
    );
  }

  return (
    <div
      className={cn(
        "w-full flex items-center gap-1.5 px-2 py-1 hover:bg-accent/50 rounded-sm text-sm",
        "transition-colors cursor-pointer select-none",
        activeFile === node.path && "bg-accent text-accent-foreground",
        isSelected && activeFile !== node.path && "bg-accent/50"
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={(e) => {
        e.stopPropagation();
        onPathSelect(node.path, false);
      }}
      onDoubleClick={() => onFileSelect(node.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, node.path, false);
      }}
    >
      {getFileIcon(node.ext)}
      <span className="truncate">{node.name}</span>
    </div>
  );
}

// Context menu component
function ContextMenu({
  x,
  y,
  path,
  isDirectory,
  hasClipboard,
  onCopy,
  onPaste,
  onDelete,
  onRename,
  onNewFile,
  onNewFolder,
  onClose,
}: {
  x: number;
  y: number;
  path: string;
  isDirectory: boolean;
  hasClipboard: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onRename: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const hasPath = path !== "";

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  const MenuItem = ({
    icon,
    label,
    onClick,
    disabled,
    danger,
  }: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
  }) => (
    <button
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent rounded transition-colors",
        disabled && "opacity-50 cursor-not-allowed",
        danger && "text-red-400 hover:text-red-300"
      )}
      onClick={() => {
        if (!disabled) {
          onClick();
          onClose();
        }
      }}
      disabled={disabled}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      ref={menuRef}
      className="fixed bg-card border border-border rounded-lg shadow-xl py-1 z-50 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      {isDirectory && (
        <>
          <MenuItem
            icon={<FilePlus className="w-4 h-4" />}
            label="New File"
            onClick={onNewFile}
          />
          <MenuItem
            icon={<FolderPlus className="w-4 h-4" />}
            label="New Folder"
            onClick={onNewFolder}
          />
          {hasPath && <div className="h-px bg-border my-1" />}
        </>
      )}
      {hasPath && (
        <>
          <MenuItem
            icon={<Copy className="w-4 h-4" />}
            label="Copy"
            onClick={onCopy}
          />
          <MenuItem
            icon={<Clipboard className="w-4 h-4" />}
            label="Paste"
            onClick={onPaste}
            disabled={!hasClipboard}
          />
          <div className="h-px bg-border my-1" />
          <MenuItem
            icon={<Pencil className="w-4 h-4" />}
            label="Rename"
            onClick={onRename}
          />
          <MenuItem
            icon={<Trash2 className="w-4 h-4" />}
            label="Delete"
            onClick={onDelete}
            danger
          />
        </>
      )}
      {!hasPath && hasClipboard && (
        <MenuItem
          icon={<Clipboard className="w-4 h-4" />}
          label="Paste"
          onClick={onPaste}
        />
      )}
    </div>
  );
}

export function FileTree({
  files,
  activeFile,
  selectedPath,
  clipboardPath,
  newItem,
  renamingPath,
  onFileSelect,
  onPathSelect,
  onNewFile,
  onNewFolder,
  onCreateItem,
  onCancelNewItem,
  onCopy,
  onPaste,
  onDelete,
  onRename,
  onRenameSubmit,
  onCancelRename,
  style,
}: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  // Get parent path for sibling creation
  const getParentPath = (path: string | null): string | null => {
    if (!path) return null;
    const parts = path.split("/");
    parts.pop();
    return parts.length > 0 ? parts.join("/") : null;
  };

  // Determine target path for new file/folder
  const getTargetPath = (selectedPath: string | null): string | null => {
    if (!selectedPath) return null;
    const findNode = (nodes: FileNode[], path: string): FileNode | null => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const found = findNode(node.children, path);
          if (found) return found;
        }
      }
      return null;
    };
    const node = findNode(files, selectedPath);
    if (node?.type === "directory") {
      return selectedPath;
    }
    return getParentPath(selectedPath);
  };

  const handleNewFile = () => {
    const targetPath = getTargetPath(selectedPath);
    onNewFile(targetPath);
  };

  const handleNewFolder = () => {
    const targetPath = getTargetPath(selectedPath);
    onNewFolder(targetPath);
  };

  const handleContextMenu = (e: React.MouseEvent, path: string, isDirectory: boolean) => {
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDirectory });
  };

  // Show new item at root level
  const showRootNewItem = newItem && newItem.parentPath === null;

  return (
    <div
      className="border-r border-border bg-card/50 flex flex-col shrink-0"
      style={style}
      onClick={() => onPathSelect(null, false)}
      onContextMenu={(e) => {
        e.preventDefault();
        // Right click on empty space
        setContextMenu({ x: e.clientX, y: e.clientY, path: "", isDirectory: true });
      }}
    >
      <div className="h-10 border-b border-border flex items-center justify-between px-3">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Explorer
        </span>
        <div className="flex items-center gap-1">
          <button
            className="p-1 hover:bg-accent rounded transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              handleNewFile();
            }}
            title="New File"
          >
            <FilePlus className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            className="p-1 hover:bg-accent rounded transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              handleNewFolder();
            }}
            title="New Folder"
          >
            <FolderPlus className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-1">
        {/* New item at root level */}
        {showRootNewItem && (
          <InlineInput
            defaultValue=""
            onSubmit={onCreateItem}
            onCancel={onCancelNewItem}
            depth={0}
            icon={
              newItem.type === "folder" ? (
                <Folder className="w-4 h-4 text-muted-foreground" />
              ) : (
                <File className="w-4 h-4 text-muted-foreground" />
              )
            }
          />
        )}
        {files.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            activeFile={activeFile}
            selectedPath={selectedPath}
            renamingPath={renamingPath}
            newItem={newItem}
            onFileSelect={onFileSelect}
            onPathSelect={onPathSelect}
            onNewFile={onNewFile}
            onContextMenu={handleContextMenu}
            onCreateItem={onCreateItem}
            onCancelNewItem={onCancelNewItem}
            onRenameSubmit={onRenameSubmit}
            onCancelRename={onCancelRename}
          />
        ))}
        {files.length === 0 && !showRootNewItem && (
          <div className="p-4 text-sm text-muted-foreground text-center">
            No files found
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          isDirectory={contextMenu.isDirectory}
          hasClipboard={!!clipboardPath}
          onCopy={() => onCopy(contextMenu.path)}
          onPaste={() => onPaste(contextMenu.isDirectory ? contextMenu.path : getParentPath(contextMenu.path))}
          onDelete={() => onDelete(contextMenu.path)}
          onRename={() => onRename(contextMenu.path)}
          onNewFile={() => onNewFile(contextMenu.isDirectory ? contextMenu.path : getParentPath(contextMenu.path))}
          onNewFolder={() => onNewFolder(contextMenu.isDirectory ? contextMenu.path : getParentPath(contextMenu.path))}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
