/**
 * One-shot DO storage seed.
 *
 * Mirrors the boot path in examples/calorie-counter/typescript/server/db.ts —
 * runs schema.sql, then bulk-inserts foods.tsv if the `foods` table is empty,
 * then runs seed.sql if the `users` table is empty. Idempotent: subsequent
 * wakes find the tables populated and skip.
 *
 * Static text imports (see wrangler.jsonc `Text` rule) bundle the .sql / .tsv
 * payloads straight into the worker artifact. There is no file system inside
 * a DO; everything has to be in the bundle.
 */

// @ts-ignore — wrangler's `Text` rule resolves .sql/.tsv as `string` modules.
import schemaSql from "./schema.sql";
// @ts-ignore
import seedSql from "./seed.sql";
// @ts-ignore
import foodsTsv from "./foods.tsv";

import { db } from "./db";

interface FoodRow {
  id: string;
  name: string;
  icon: string;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  serving_label: string;
  category: string;
  sort_order: number;
}

function loadFoodsFromTsv(): number {
  const lines = (foodsTsv as string).split("\n");
  let header: string[] | null = null;
  const rows: FoodRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols.map((c) => c.trim());
      continue;
    }
    if (cols.length < header.length) continue;
    const get = (key: string) => cols[header!.indexOf(key)]?.trim() ?? "";
    const row: FoodRow = {
      id: get("id"),
      name: get("name"),
      icon: get("icon") || "🍽️",
      calories: Number(get("calories")) || 0,
      carbs_g: Number(get("carbs_g")) || 0,
      protein_g: Number(get("protein_g")) || 0,
      fat_g: Number(get("fat_g")) || 0,
      serving_label: get("serving_label") || "1 serving",
      category: get("category") || "popular",
      sort_order: Number(get("sort_order")) || 0,
    };
    if (!row.id || !row.name) continue;
    rows.push(row);
  }

  db.transaction(() => {
    for (const r of rows) {
      db.query(
        `INSERT OR IGNORE INTO foods
          (id, name, icon, calories, carbs_g, protein_g, fat_g, serving_label, category, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        r.id, r.name, r.icon, r.calories, r.carbs_g, r.protein_g, r.fat_g,
        r.serving_label, r.category, r.sort_order
      );
    }
  })();

  return rows.length;
}

export function initSchema(): void {
  db.exec(schemaSql as string);

  const foodCount = (db.query("SELECT COUNT(*) AS n FROM foods").get() as { n: number } | undefined)?.n ?? 0;
  if (foodCount === 0) {
    const n = loadFoodsFromTsv();
    console.log(`Loaded ${n} foods from foods.tsv`);
  }

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
