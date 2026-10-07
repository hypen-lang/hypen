import { describe, expect, test } from "bun:test";
import module, { initialState, derive } from "./App";
import { money, search } from "./market";

async function action(name: string, state: ReturnType<typeof initialState>, payload = {}) {
  await module.handlers.onAction.get(name)!({ state, action: { name, payload } } as any);
}

describe("paper portfolio", () => {
  test("snapshot prices reconcile with shares, cost basis and allocation", () => {
    const s = initialState(); derive(s);
    expect(s.total).toBe("$6,921.74");
    expect(s.gain).toBe("+$541.74 unrealized");
    expect(s.allocation).toHaveLength(3);
    expect(money(s.portfolio.at(-1)![1])).toBe(s.total);
  });
  test("adding shares computes weighted cost; removing all is valid", async () => {
    const s = initialState(); derive(s); s.sharesInput = "3"; s.costInput = "200";
    await action("add", s);
    expect(s.holdings[0]).toEqual({ symbol: "IBM", shares: 15, cost: 232 });
    for (const h of [...s.holdings]) await action("remove", s, { symbol: h.symbol });
    expect(s.total).toBe("$0.00"); expect(s.gain).toBe("+$0.00 unrealized");
    expect(s.allocation).toEqual([]);
  });
  test("invalid holding inputs preserve balances", async () => {
    const s = initialState(); derive(s); const before = s.total;
    for (const value of ["-1", "0", "Infinity", "nope"]) { s.sharesInput = value; await action("add", s); expect(s.total).toBe(before); }
  });
  test("symbol, watchlist and range actions update chart state", async () => {
    const s = initialState(); derive(s);
    await action("select", s, { symbol: "AAPL" }); expect(s.source).toContain("Synthetic");
    await action("watch", s); expect(s.watchlist).toContain("AAPL");
    await action("watch", s); expect(s.watchlist).not.toContain("AAPL");
    await action("range", s, { days: 10 }); expect(s.points).toHaveLength(10);
    await action("select", s, { symbol: "UNKNOWN" }); expect(s.symbol).toBe("AAPL");
    expect(search("  machines ").map(s => s.symbol)).toEqual(["IBM"]);
    expect(search("unknown")).toEqual([]);
  });
});

test("navigation, stock discovery and portfolio periods stay consistent", async () => {
  const s = initialState(); derive(s);
  expect(s.assetRows).toHaveLength(4);
  for (const page of ["markets", "portfolio", "watchlist", "dashboard"]) {
    await action("navigate", s, { page }); expect(s.page).toBe(page);
  }
  await action("navigate", s, { page: "invalid" }); expect(s.page).toBe("dashboard");
  s.query = "apple"; await action("search", s); expect(s.filteredAssets.map(a => a.symbol)).toEqual(["AAPL"]);
  await action("select", s, { symbol: "AAPL" }); expect(s.page).toBe("markets");
  await action("watch", s); expect(s.savedAssets.some(a => a.symbol === "AAPL")).toBe(true);
  const total = s.total;
  await action("portfolioRange", s, { days: 10 }); expect(s.portfolio).toHaveLength(10);
  expect(s.portfolioGrid.every(x => x > 0 && x < 9)).toBe(true);
  expect(s.total).toBe(total);
});
