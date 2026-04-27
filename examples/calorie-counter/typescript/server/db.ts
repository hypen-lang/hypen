import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

const dataDir = resolve(import.meta.dir, "../../data");

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

// ---------------------------------------------------------------------------
// TSV loader for the bulk food library.
//
// Lives in data/foods.tsv so additions don't balloon seed.sql. Header row,
// blank lines, and `#`-prefixed comments are skipped. Columns must be in the
// order declared by the header; each row maps 1:1 to a `foods` row.
// ---------------------------------------------------------------------------
function loadFoodsFromTsv(db: Database) {
  const tsvPath = resolve(dataDir, "foods.tsv");
  const raw = readFileSync(tsvPath, "utf-8");
  const lines = raw.split("\n");

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
    if (cols.length < header.length) continue; // ragged row, skip

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

  const insert = db.prepare(
    `INSERT OR IGNORE INTO foods
      (id, name, icon, calories, carbs_g, protein_g, fat_g, serving_label, category, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) {
      insert.run(
        r.id, r.name, r.icon, r.calories, r.carbs_g, r.protein_g, r.fat_g,
        r.serving_label, r.category, r.sort_order
      );
    }
  })();
  return rows.length;
}

function initDatabase(): Database {
  const db = new Database(resolve(import.meta.dir, "../calorie-counter.db"));
  db.exec("PRAGMA journal_mode = WAL");

  const schema = readFileSync(resolve(dataDir, "schema.sql"), "utf-8");
  db.exec(schema);

  // Foods table: load from foods.tsv if empty. Safe to re-run — `INSERT OR
  // IGNORE` means expanding the TSV later doesn't duplicate existing rows.
  const foodCount = (db.query("SELECT COUNT(*) AS n FROM foods").get() as { n: number }).n;
  if (foodCount === 0) {
    const n = loadFoodsFromTsv(db);
    console.log(`Loaded ${n} foods from data/foods.tsv`);
  }

  // Seed (users, meal_goals, sample entries): only on an empty users table.
  const userCount = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (userCount === 0) {
    const raw = readFileSync(resolve(dataDir, "seed.sql"), "utf-8");
    const stripped = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (stripped.length > 0) {
      db.exec(raw);
      console.log("Database seeded from data/seed.sql");
    } else {
      console.log("seed.sql is empty — no users seeded");
    }
  }

  return db;
}

export const db = initDatabase();
