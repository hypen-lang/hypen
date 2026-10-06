import { app } from "@hypen-space/core/app";
import { catalog, fixture, fetchDaily, money, search, type Price } from "./market";

type AssetRow = { symbol: string; name: string; price: string; change: string; color: string; badge: string; initials: string };
type Holding = { symbol: string; shares: number; cost: number };
export function initialState() {
  return {
    page: "dashboard", portfolioRange: 30, portfolioGrid: [0, 0, 0, 0, 0], gainPercent: "", gainColor: "#75bb8b", assetRows: [] as AssetRow[], filteredAssets: [] as AssetRow[], savedAssets: [] as AssetRow[],
    symbol: "IBM", company: "International Business Machines", query: "", results: catalog,
    watchlist: ["IBM", "NVDA"], watchRows: [] as { symbol: string; price: string }[], saved: true,
    histories: Object.fromEntries(catalog.map(s => [s.symbol, fixture(s.symbol)])) as Record<string, Price[]>,
    sources: Object.fromEntries(catalog.map(s => [s.symbol, s.symbol === "IBM" ? "Alpha Vantage snapshot" : "Synthetic demo data"])) as Record<string, string>,
    holdings: [{ symbol: "IBM", shares: 12, cost: 240 }, { symbol: "AAPL", shares: 8, cost: 200 }, { symbol: "MSFT", shares: 5, cost: 380 }] as Holding[],
    sharesInput: "1", costInput: "", range: 30, price: "", change: "", source: "", status: "",
    points: [] as number[][], volume: [] as number[][], domain: [0, 1], baseline: 0,
    period: "", hover: { x: null as number | null, y: null as number | null, label: "" },
    total: "", gain: "", portfolio: [] as number[][], allocation: [] as { symbol: string; value: number }[],
    holdingRows: [] as { symbol: string; label: string; value: string }[], selected: null as number | null,
  };
}
type State = ReturnType<typeof initialState>;
export function derive(s: State) {
  const names: Record<string, string> = { IBM: "IBM", AAPL: "Apple", MSFT: "Microsoft", NVDA: "NVIDIA" };
  const badges: Record<string, string> = { IBM: "#324c76", AAPL: "#3b3c3f", MSFT: "#6e4ca6", NVDA: "#455d31" };
  s.assetRows = catalog.map(c => {
    const prices = s.histories[c.symbol]; const last = prices.at(-1)!.close;
    const day = (last / prices.at(-2)!.close - 1) * 100;
    return { symbol: c.symbol, name: names[c.symbol], price: money(last), change: `${day >= 0 ? "+" : ""}${day.toFixed(2)}%`, color: day >= 0 ? "#75bb8b" : "#ef8890", badge: badges[c.symbol], initials: c.symbol === "IBM" ? "ibm" : names[c.symbol].slice(0,1) };
  });
  s.results = search(s.query);
  s.filteredAssets = s.assetRows.filter(a => s.results.some(c => c.symbol === a.symbol));
  s.savedAssets = s.assetRows.filter(a => s.watchlist.includes(a.symbol));
  const all = s.histories[s.symbol];
  const rows = all.slice(-s.range);
  const last = rows.at(-1)!;
  s.company = catalog.find(c => c.symbol === s.symbol)!.name;
  s.price = money(last.close);
  const delta = (last.close / rows[0].close - 1) * 100;
  s.change = `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}% over ${rows.length} sessions`;
  s.source = `${s.sources[s.symbol]} · ${last.date}`;
  s.period = `${rows[0].date}  —  ${last.date}`;
  s.points = rows.map((r, i) => [i, r.close]);
  s.volume = rows.map((r, i) => [i, r.volume / 1_000_000]);
  const low = Math.min(...rows.map(r => r.close)), high = Math.max(...rows.map(r => r.close));
  const pad = Math.max((high - low) * 0.18, 1);
  s.domain = [Math.floor(low - pad), Math.ceil(high + pad)];
  s.baseline = rows[0].close;
  s.saved = s.watchlist.includes(s.symbol);
  s.watchRows = s.watchlist.map(symbol => ({ symbol, price: money(s.histories[symbol].at(-1)!.close) }));
  let value = 0, cost = 0;
  s.allocation = s.holdings.map(h => { const v = h.shares * s.histories[h.symbol].at(-1)!.close; value += v; cost += h.shares * h.cost; return { symbol: h.symbol, value: Math.round(v) }; });
  s.total = money(value);
  s.gainPercent = `${value >= cost ? "+" : ""}${cost > 0 ? ((value / cost - 1) * 100).toFixed(2) : "0.00"}%`;
  s.gainColor = value >= cost ? "#75bb8b" : "#ef8890";
  s.gain = `${value >= cost ? "+" : "−"}${money(Math.abs(value - cost))} unrealized`;
  s.holdingRows = s.holdings.map(h => ({ symbol: h.symbol, label: `${h.shares} shares · avg ${money(h.cost)}`, value: money(h.shares * s.histories[h.symbol].at(-1)!.close) }));
  // Revalue today's holdings at common historical dates; excludes cash flows.
  const dates = s.histories.IBM.slice(-s.portfolioRange).map(r => r.date).filter(date => s.holdings.every(h => s.histories[h.symbol].some(r => r.date === date)));
  s.portfolio = dates.map((date, i) => [i, s.holdings.reduce((n, h) => n + h.shares * s.histories[h.symbol].find(r => r.date === date)!.close, 0)]);
  s.portfolioGrid = [1, 2, 3, 4, 5].map(n => (s.portfolio.length - 1) * n / 6);
}
const start = initialState(); derive(start);
export default app.module("App").defineState(start)
  .onAction<{ page: string }>("navigate", ({ state, action }) => {
    if (["dashboard", "markets", "portfolio", "watchlist"].includes(action.payload?.page ?? "")) {
      state.page = action.payload!.page; state.status = "";
    }
  })
  .onAction<{ days: number }>("portfolioRange", ({ state, action }) => {
    if ([10, 30, 100].includes(action.payload?.days ?? 0)) { state.portfolioRange = action.payload!.days; derive(state); }
  })
  .onAction("search", ({ state }) => { derive(state); })
  .onAction<{ symbol: string }>("select", ({ state, action }) => {
    if (!catalog.some(c => c.symbol === action.payload?.symbol)) return;
    state.page = "markets"; state.symbol = action.payload!.symbol; state.hover = { x: null, y: null, label: "" }; state.status = ""; derive(state);
  })
  .onAction<{ days: number }>("range", ({ state, action }) => {
    if (![10, 30, 100].includes(action.payload?.days ?? 0)) return;
    state.range = action.payload!.days; state.hover = { x: null, y: null, label: "" }; derive(state);
  })
  .onAction("watch", ({ state }) => { state.watchlist = state.saved ? state.watchlist.filter(s => s !== state.symbol) : [...state.watchlist, state.symbol]; derive(state); })
  .onAction("refresh", async ({ state }) => {
    const symbol = state.symbol; state.status = "Refreshing daily prices…";
    try { state.histories[symbol] = await fetchDaily(symbol); state.sources[symbol] = "Alpha Vantage daily"; state.status = `Updated ${symbol}`; derive(state); }
    catch (e) { state.status = e instanceof Error ? e.message : "Refresh unavailable"; }
  })
  .onAction<{ x: number; y: number }>("inspect", ({ state, action }) => {
    const p = action.payload;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) state.hover = { x: p.x, y: p.y, label: money(p.y) };
  })
  .onAction<{ index: number }>("allocation", ({ state, action }) => { state.selected = action.payload?.index ?? null; })
  .onAction("add", ({ state }) => {
    const shares = Number(state.sharesInput), cost = state.costInput.trim() ? Number(state.costInput) : state.histories[state.symbol].at(-1)!.close;
    if (!(shares > 0 && Number.isFinite(shares) && cost > 0 && Number.isFinite(cost))) { state.status = "Enter positive shares and cost"; return; }
    const old = state.holdings.find(h => h.symbol === state.symbol);
    state.holdings = old ? state.holdings.map(h => h.symbol === state.symbol ? { ...h, shares: h.shares + shares, cost: (h.shares * h.cost + shares * cost) / (h.shares + shares) } : h) : [...state.holdings, { symbol: state.symbol, shares, cost }];
    state.status = `Added ${shares} ${state.symbol} paper shares`; derive(state);
  })
  .onAction<{ symbol: string }>("remove", ({ state, action }) => { state.holdings = state.holdings.filter(h => h.symbol !== action.payload?.symbol); derive(state); })
  .ui(await Bun.file(new URL(process.env.CHARTS_ONLY === "1" ? "./Charts.hypen" : "./App.hypen", import.meta.url)).text());
