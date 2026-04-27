import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type ResizeHandleProps = {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
};

export function ResizeHandle({ direction, onResize }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      lastPos.current = direction === "vertical" ? e.clientX : e.clientY;
      setDragging(true);
    },
    [direction]
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const current = direction === "vertical" ? e.clientX : e.clientY;
      const delta = current - lastPos.current;
      lastPos.current = current;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    // Prevent text selection while dragging
    document.body.style.userSelect = "none";
    document.body.style.cursor =
      direction === "vertical" ? "col-resize" : "row-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragging, direction, onResize]);

  const isVertical = direction === "vertical";

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        "relative flex-shrink-0 bg-transparent transition-colors",
        isVertical
          ? "w-1 cursor-col-resize hover:bg-primary/20"
          : "h-1 cursor-row-resize hover:bg-primary/20",
        dragging && "bg-primary/30"
      )}
    >
      {/* Wider invisible hit area */}
      <div
        className={cn(
          "absolute z-10",
          isVertical
            ? "inset-y-0 -left-1 -right-1"
            : "inset-x-0 -top-1 -bottom-1"
        )}
      />
    </div>
  );
}
