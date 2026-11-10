/**
 * The windowed list, for comparing against Hypen versions whose `List` is
 * virtualized by default.
 *
 * TanStack Virtual with the window as the scroll container — the page scrolls
 * in this UI, and that is the container Hypen's DOM renderer reports against
 * too. The row markup is the same memoised `RowCard` the plain build uses.
 *
 * Off-window rows are stood in for by padding on the list element, which is
 * the same shape Hypen produces (spacers before and after the materialised
 * rows, no wrapper per row), and overscan is one viewport's worth of rows on
 * each side, which is Hypen's rule (hypen-web/docs/virtualization.md §3).
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { Row } from "../../../shared/data";
import { T } from "../../../shared/theme";
import { RowCard } from "./App";
import * as S from "./styles";

/** Rendered height of one row card; rows are fixed-height in this UI. */
const ROW_HEIGHT = 56;

interface Props {
  rows: Row[];
  onSelect: (id: number) => void;
  onRemove: (id: number) => void;
}

export function VirtualRows({ rows, onSelect, onRemove }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const top =
      (listRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
    setScrollMargin((prev) => (prev === top ? prev : top));
  }, []);

  const overscan = useMemo(
    () => Math.max(5, Math.ceil(window.innerHeight / (ROW_HEIGHT + T.gapSm))),
    [],
  );

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_HEIGHT,
    gap: T.gapSm,
    overscan,
    scrollMargin,
    getItemKey: (i) => rows[i].id,
  });

  const items = virtualizer.getVirtualItems();
  const paddingTop = items.length ? items[0].start - scrollMargin : 0;
  const paddingBottom = items.length
    ? virtualizer.getTotalSize() - (items[items.length - 1].end - scrollMargin)
    : 0;

  return (
    <div ref={listRef} style={{ ...S.list, paddingTop, paddingBottom }}>
      {items.map((item) => (
        <RowCard
          key={item.key}
          row={rows[item.index]}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
