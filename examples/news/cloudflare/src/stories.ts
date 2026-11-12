// Story rows as the templates see them: a StoryLite from the hub, decorated
// with this visitor's read/saved flags and the live-update deltas.

import { compact, plural, timeAgo } from "./format";
import type { Library } from "./scope";
import { hnUrl, type StoryLite } from "./upstream";

export interface StoryRow {
  /** ForEach key — string so it is stable across JSON round trips. */
  id: string;
  hnId: number;
  rank: number;
  title: string;
  domain: string;
  url: string;
  hnUrl: string;
  score: number;
  scoreLabel: string;
  commentsLabel: string;
  byline: string;
  read: boolean;
  saved: boolean;
  /** "▲3" / "▼2" / "NEW" for one poll after a rank change, else "". */
  delta: string;
  deltaColor: string;
  /** Score went up since the previous poll — the row flashes. */
  bumped: boolean;
  kind: string;
}

const UP = "#34D399";
const DOWN = "#F87171";
const NEW = "#FBBF24";

export function toRow(s: StoryLite, rank: number, lib: Library | null, prev?: StoryRow, hadPrev = false): StoryRow {
  let delta = "";
  let deltaColor = UP;
  if (prev && prev.rank !== rank) {
    const diff = prev.rank - rank;
    delta = diff > 0 ? `▲${diff}` : `▼${-diff}`;
    deltaColor = diff > 0 ? UP : DOWN;
  } else if (!prev && hadPrev) {
    delta = "NEW";
    deltaColor = NEW;
  }
  const isJob = s.type === "job";
  return {
    id: String(s.id),
    hnId: s.id,
    rank,
    title: s.title,
    domain: s.domain,
    url: s.url,
    hnUrl: hnUrl(s.id),
    score: s.score,
    scoreLabel: isJob ? "job" : `${compact(s.score)} pts`,
    commentsLabel: isJob ? "" : plural(s.comments, "comment"),
    byline: [s.by && `by ${s.by}`, timeAgo(s.time)].filter(Boolean).join(" · "),
    read: lib?.readIds.has(s.id) ?? false,
    saved: lib?.savedIds.has(s.id) ?? false,
    delta,
    deltaColor,
    bumped: !!prev && s.score > prev.score,
    kind: s.type,
  };
}

/** Decorate a fresh list, diffing against what the client currently shows. */
export function toRows(stories: StoryLite[], lib: Library | null, previous: StoryRow[] = []): StoryRow[] {
  const prevById = new Map(previous.map((r) => [r.id, r]));
  const hadPrev = previous.length > 0;
  return stories.map((s, i) => toRow(s, i + 1, lib, prevById.get(String(s.id)), hadPrev));
}
