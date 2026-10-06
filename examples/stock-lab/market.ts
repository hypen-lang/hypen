import snapshot from "./ibm-snapshot.json";

export type Price = { date: string; close: number; volume: number };
export const catalog = [
  { symbol: "IBM", name: "International Business Machines" },
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "NVIDIA" },
];
// Other symbols are explicitly synthetic fixtures; only IBM is an API snapshot.
const bases = { AAPL: 225, MSFT: 430, NVDA: 145 };
export function fixture(symbol: string): Price[] {
  if (symbol === "IBM") return snapshot.rows;
  const base = bases[symbol as keyof typeof bases];
  if (!base) throw new Error("Unknown fixture symbol");
  return snapshot.rows.map((r, i) => ({ date: r.date,
    close: Math.round((base * (0.88 + i * 0.0014) + Math.sin(i * 0.53) * base * 0.025) * 100) / 100,
    volume: Math.round(2_000_000 + (1 + Math.sin(i * 0.71)) * 3_000_000) }));
}
export const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function search(query: string) {
  const q = query.trim().toLowerCase();
  return catalog.filter(s => `${s.symbol} ${s.name}`.toLowerCase().includes(q));
}
const cache = new Map<string, { at: number; rows: Price[] }>();
export async function fetchDaily(symbol: string): Promise<Price[]> {
  if (!catalog.some(s => s.symbol === symbol)) throw new Error("Unknown symbol");
  const key = process.env.ALPHA_VANTAGE_API_KEY || "demo";
  if (key === "demo" && symbol !== "IBM") throw new Error("Add a free API key to refresh other symbols");
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.rows;
  const url = new URL("https://www.alphavantage.co/query");
  url.search = new URLSearchParams({ function: "TIME_SERIES_DAILY", symbol, apikey: key }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error("Market data request failed");
  const body = await res.json() as Record<string, any>;
  if (!body["Time Series (Daily)"]) throw new Error("API limit reached or key unavailable; keeping saved data");
  const rows = Object.entries(body["Time Series (Daily)"]).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]: [string, any]) => ({ date, close: Number(v["4. close"]), volume: Number(v["5. volume"]) }))
    .filter(r => Number.isFinite(r.close) && r.close > 0 && Number.isFinite(r.volume));
  if (!rows.length) throw new Error("No valid market prices returned");
  cache.set(symbol, { at: Date.now(), rows });
  return rows;
}
