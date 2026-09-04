/**
 * Hypen module for the benchmark UI.
 *
 * One action per toolbar control, doing exactly the same data work as the
 * React `run()` switch — both call into `shared/data.ts`, so the only thing
 * that differs between the two apps is how the resulting array reaches the
 * DOM.
 */

import { app } from "@hypen-space/core";
import { buildRows, ops, type Row } from "../../../shared/data";
import { PARITY_ROWS } from "../../../shared/scenarios";
import { template } from "./template";

export interface BenchState {
  rows: Row[];
}

export default app
  .defineState<BenchState>({ rows: [] })
  .onAction("createOneK", async ({ state }) => {
    state.rows = buildRows(1000);
  })
  .onAction("createTenK", async ({ state }) => {
    state.rows = buildRows(10000);
  })
  .onAction("replaceOneK", async ({ state }) => {
    state.rows = buildRows(1000);
  })
  .onAction("appendOneK", async ({ state }) => {
    state.rows = state.rows.concat(buildRows(1000));
  })
  .onAction("updateEveryTenth", async ({ state }) => {
    state.rows = ops.updateEveryTenth(state.rows);
  })
  .onAction("updateAll", async ({ state }) => {
    state.rows = ops.updateAll(state.rows);
  })
  .onAction("selectRow", async ({ state }) => {
    state.rows = ops.select(state.rows, 0);
  })
  .onAction("swapRows", async ({ state }) => {
    state.rows = ops.swap(state.rows, 1, 998);
  })
  .onAction("removeRow", async ({ state }) => {
    state.rows = ops.removeAt(state.rows, 1);
  })
  .onAction("clear", async ({ state }) => {
    state.rows = [];
  })
  .onAction("parity", async ({ state }) => {
    state.rows = buildRows(PARITY_ROWS, 7);
  })
  .onAction<{ id: string }>("rowSelect", async ({ action, state }) => {
    const id = Number(action.payload?.id);
    const i = state.rows.findIndex((r) => r.id === id);
    if (i >= 0) state.rows = ops.select(state.rows, i);
  })
  .onAction<{ id: string }>("rowRemove", async ({ action, state }) => {
    const id = Number(action.payload?.id);
    const i = state.rows.findIndex((r) => r.id === id);
    if (i >= 0) state.rows = ops.removeAt(state.rows, i);
  })
  .ui(template);
