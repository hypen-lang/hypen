/**
 * One-shot DO storage seed. Mirrors examples/social/typescript/server/db.ts
 * minus the file-system reads — schema + seed text comes through wrangler's
 * Text rule.
 */

// @ts-ignore
import schemaSql from "./schema.sql";
// @ts-ignore
import seedSql from "./seed.sql";

import { db } from "./db";
import { MEDIA_SCHEMA } from "./media";

export function initSchema(): void {
  db.exec(schemaSql as string);
  db.exec(MEDIA_SCHEMA);

  const stripped = (seedSql as string)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  if (stripped.length > 0) {
    // Every seed insert is idempotent, so this doubles as a tiny data
    // migration for Durable Objects that already existed before new demo
    // people, stories, or conversations were added.
    db.exec(seedSql as string);
  }
}
