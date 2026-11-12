// Small display helpers shared by the hub and the screen modules.

export function timeAgo(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 24) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function domainOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function longDate(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function monthDay(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Run `fn` over `items` with at most `limit` in flight; keeps order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
