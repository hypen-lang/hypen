// NewsHub — one shared Durable Object (named "hub") that owns every upstream
// request. Visitor DOs never call Hacker News or Wikipedia directly; they ask
// the hub over DO RPC, so a thousand open tabs still cost one HN poll.
//
//   - Lists (top/new/best/…) are re-polled at most every LIST_TTL; only the
//     first LIST_LIMIT ids are hydrated, with bounded concurrency, and each
//     item has its own TTL — so a busy hub refreshes ~30 items per list per
//     half-minute, not 500 per client.
//   - Comment items are cached longer (they rarely change) and fetched only
//     when a session expands that part of the tree.
//   - Wikipedia responses are cached for tens of minutes to hours.
//   - Every entry is single-flight (concurrent askers share one fetch) and
//     stale-on-error: if upstream fails or rate-limits (Wikimedia answers 429
//     to bursts) the last good value is served.
//
// The cache is in memory: if the hub is evicted it simply refills on demand.

import { DurableObject } from "cloudflare:workers";
import { mapLimit } from "./format";
import {
  fetchFeatured,
  fetchHnIds,
  fetchHnItem,
  fetchOnThisDay,
  fetchSummary,
  HN_KINDS,
  toStoryLite,
  type FeaturedDigest,
  type HnItem,
  type HnKind,
  type OtdEvent,
  type OtdKind,
  type StoryLite,
  type WikiSummary,
} from "./upstream";

const LIST_TTL = 20_000;
const LIST_ITEM_TTL = 30_000;
const COMMENT_TTL = 5 * 60_000;
const FEATURED_TTL = 30 * 60_000;
const OTD_TTL = 6 * 60 * 60_000;
const SUMMARY_TTL = 60 * 60_000;
const FAIL_TTL = 15_000;
export const LIST_LIMIT = 30;
const HN_CONCURRENCY = 8;
const MAX_ENTRIES = 4000;

interface Entry<T> {
  value?: T;
  expires: number;
  pending?: Promise<T>;
  error?: unknown;
}

export interface StoryList {
  kind: HnKind;
  fetchedAt: number;
  stories: StoryLite[];
}

export class NewsHub extends DurableObject {
  private cache = new Map<string, Entry<unknown>>();

  /** Single-flight, TTL'd, stale-on-error cache lookup. */
  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.cache.get(key) as Entry<T> | undefined;
    if (entry) {
      // Map order doubles as an LRU: re-insert on touch.
      this.cache.delete(key);
      this.cache.set(key, entry);
      if (entry.pending) return entry.pending;
      if (entry.expires > now) {
        if (entry.value !== undefined) return Promise.resolve(entry.value);
        return Promise.reject(entry.error);
      }
    }
    const next: Entry<T> = entry ?? { expires: 0 };
    next.pending = load()
      .then((value) => {
        next.value = value;
        next.error = undefined;
        next.expires = Date.now() + ttl;
        return value;
      })
      .catch((error) => {
        next.expires = Date.now() + FAIL_TTL;
        if (next.value !== undefined) return next.value; // stale beats nothing
        next.error = error;
        throw error;
      })
      .finally(() => {
        next.pending = undefined;
      });
    this.cache.set(key, next as Entry<unknown>);
    this.evict();
    return next.pending;
  }

  private evict(): void {
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private item(id: number, ttl: number): Promise<HnItem | null> {
    return this.cached(`item:${id}`, ttl, () => fetchHnItem(id)).catch(() => null);
  }

  // ---- RPC surface --------------------------------------------------------

  /** The first `limit` stories of an HN list, hydrated. */
  async list(kind: HnKind, limit = LIST_LIMIT): Promise<StoryList> {
    if (!HN_KINDS.includes(kind)) kind = "top";
    return this.cached(`list:${kind}:${limit}`, LIST_TTL, async () => {
      const ids = (await this.cached(`ids:${kind}`, LIST_TTL, () => fetchHnIds(kind))).slice(0, limit);
      const items = await mapLimit(ids, HN_CONCURRENCY, (id) => this.item(id, LIST_ITEM_TTL));
      const stories = items
        .filter((it): it is HnItem => !!it && !it.deleted && !it.dead)
        .map(toStoryLite);
      return { kind, fetchedAt: Date.now(), stories };
    });
  }

  /** One story (or comment), fresh within LIST_ITEM_TTL. */
  async story(id: number): Promise<HnItem | null> {
    return this.item(id, LIST_ITEM_TTL);
  }

  /** Comment children, in the given order, bounded concurrency. */
  async comments(ids: number[]): Promise<HnItem[]> {
    const capped = ids.slice(0, 60);
    const items = await mapLimit(capped, HN_CONCURRENCY, (id) => this.item(id, COMMENT_TTL));
    // Deleted comments are dropped unless replies hang off them.
    return items.filter((it): it is HnItem => !!it && (!it.deleted || (it.kids?.length ?? 0) > 0));
  }

  /** Wikipedia's featured feed for a UTC date (YYYY-MM-DD). */
  async featured(date: string): Promise<FeaturedDigest> {
    return this.cached(`featured:${date}`, FEATURED_TTL, () => fetchFeatured(new Date(`${date}T00:00:00Z`)));
  }

  async onThisDay(kind: OtdKind, month: string, day: string): Promise<OtdEvent[]> {
    return this.cached(`otd:${kind}:${month}-${day}`, OTD_TTL, () => fetchOnThisDay(kind, month, day));
  }

  async summary(title: string): Promise<WikiSummary> {
    return this.cached(`summary:${title}`, SUMMARY_TTL, () => fetchSummary(title));
  }
}

/** The RPC surface as seen from a visitor DO. */
export type HubStub = Pick<NewsHub, "list" | "story" | "comments" | "featured" | "onThisDay" | "summary">;
