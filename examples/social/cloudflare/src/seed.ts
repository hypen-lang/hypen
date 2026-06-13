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

export function initSchema(): void {
  db.exec(schemaSql as string);

  const userCount = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number } | undefined)?.n ?? 0;
  if (userCount === 0) {
    const stripped = (seedSql as string)
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (stripped.length > 0) {
      db.exec(seedSql as string);
      console.log("DO storage seeded from seed.sql");
    }
  }
}
