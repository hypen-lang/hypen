/**
 * React implementation of the benchmark UI.
 *
 * Written the way a competent React app would be written in 2026: function
 * components, `useState` + functional updates, stable `useCallback` handlers
 * and a `memo`-wrapped row so a single-row change doesn't re-render the other
 * 999. No virtualisation — the Hypen side isn't virtualised either, and the
 * point is to compare how each runtime gets a full list into the DOM.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildRows, ops, type Row } from "../../../shared/data";
import { STATS } from "../../../shared/theme";
import { CONTROLS, PARITY_ROWS } from "../../../shared/scenarios";
import * as S from "./styles";

const statusStyles = new Map<string, ReturnType<typeof S.statusTextFor>>();
function statusStyle(color: string) {
  let s = statusStyles.get(color);
  if (!s) {
    s = S.statusTextFor(color);
    statusStyles.set(color, s);
  }
  return s;
}

interface RowProps {
  row: Row;
  onSelect: (id: number) => void;
  onRemove: (id: number) => void;
}

const RowCard = memo(function RowCard({ row, onSelect, onRemove }: RowProps) {
  return (
    <div style={row.selected ? S.cardSelected : S.card}>
      <div style={S.avatar}>
        <span style={S.avatarText}>{row.initials}</span>
      </div>
      <div style={S.mainCol}>
        <span style={S.nameText}>{row.name}</span>
        <div style={S.metaRow}>
          <span style={S.metaText}>{row.team}</span>
          <span style={S.metaText}>·</span>
          <span style={S.metaText}>{row.meta}</span>
        </div>
      </div>
      <div style={S.statusCol}>
        <span style={statusStyle(row.statusColor)}>{row.status}</span>
      </div>
      <div style={S.valueCol}>
        <span style={S.valueText}>{row.value}</span>
      </div>
      <button
        style={S.selectButton}
        aria-label="row-select"
        onClick={() => onSelect(row.id)}
      >
        <span style={S.selectButtonText}>Select</span>
      </button>
      <button
        style={S.removeButton}
        aria-label="row-remove"
        onClick={() => onRemove(row.id)}
      >
        <span style={S.removeButtonText}>✕</span>
      </button>
    </div>
  );
});

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const ready = useRef(false);

  const run = useCallback((id: string) => {
    switch (id) {
      case "create-1k":
      case "replace-1k":
        setRows(buildRows(1000));
        break;
      case "create-10k":
        setRows(buildRows(10000));
        break;
      case "append-1k":
        setRows((r) => r.concat(buildRows(1000)));
        break;
      case "update-10th":
        setRows(ops.updateEveryTenth);
        break;
      case "update-all":
        setRows(ops.updateAll);
        break;
      case "select-row":
        setRows((r) => ops.select(r, 0));
        break;
      case "swap-rows":
        setRows((r) => ops.swap(r, 1, 998));
        break;
      case "remove-row":
        setRows((r) => ops.removeAt(r, 1));
        break;
      case "clear":
        setRows([]);
        break;
      case "parity":
        setRows(buildRows(PARITY_ROWS, 7));
        break;
    }
  }, []);

  const onSelect = useCallback((id: number) => {
    setRows((r) => {
      const i = r.findIndex((x) => x.id === id);
      return i < 0 ? r : ops.select(r, i);
    });
  }, []);

  const onRemove = useCallback((id: number) => {
    setRows((r) => {
      const i = r.findIndex((x) => x.id === id);
      return i < 0 ? r : ops.removeAt(r, i);
    });
  }, []);

  const controls = useMemo(
    () =>
      CONTROLS.map((c) => (
        <button
          key={c.id}
          style={S.toolButton}
          aria-label={c.id}
          onClick={() => run(c.id)}
        >
          <span style={S.toolButtonText}>{c.caption}</span>
        </button>
      )),
    [run],
  );

  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    // Same readiness contract as the Hypen app: flip the flag after the
    // browser has actually painted the first frame.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        (window as any).__appReady = true;
        (window as any).__startupMs = performance.now();
      }),
    );
  }, []);

  return (
    // Hypen's `module App { … }` declaration contributes no element of its
    // own — the engine mounts the template's root `Column` straight into the
    // container — so React mounts its root `div` straight in too.
    <div style={S.root} data-framework="react">
      <div style={S.header}>
        <div style={S.brandCol}>
          <span style={S.brand}>Ops Console</span>
          <span style={S.brandSub}>realtime pipeline health</span>
        </div>
        <div style={S.spacer} />
        {/* One interpolation, not `{n} rows`: two adjacent text nodes
            measure a fraction of a pixel wider than one, and Hypen emits a
            single node. */}
        <span style={S.rowCount}>{`${rows.length} rows`}</span>
      </div>

      <div style={S.statsRow}>
        {STATS.map((s) => (
          <div key={s.label} style={S.statCard}>
            <span style={S.statLabel}>{s.label}</span>
            <span style={S.statValue}>{s.value}</span>
            <span style={s.positive ? S.statDeltaUp : S.statDeltaDown}>
              {s.delta}
            </span>
          </div>
        ))}
      </div>

      <div style={S.toolbar}>{controls}</div>

      <div style={S.listWrap}>
        <div style={S.list}>
          {rows.map((row) => (
            <RowCard
              key={row.id}
              row={row}
              onSelect={onSelect}
              onRemove={onRemove}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
