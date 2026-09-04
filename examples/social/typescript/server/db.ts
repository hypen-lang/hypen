import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

const dataDir = resolve(import.meta.dir, "../../data");

function initDatabase(): Database {
  const db = new Database(resolve(import.meta.dir, "../instagram.db"));
  db.exec("PRAGMA journal_mode = WAL");

  const schema = readFileSync(resolve(dataDir, "schema.sql"), "utf-8");
  db.exec(schema);

  // Idempotent inserts let the demo data act as a small migration too: an
  // existing local database gains newly added people, stories, and DMs.
  const seed = readFileSync(resolve(dataDir, "seed.sql"), "utf-8");
  db.exec(seed);

  return db;
}

export const db = initDatabase();
