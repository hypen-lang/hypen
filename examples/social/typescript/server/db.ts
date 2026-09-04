import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

const dataDir = resolve(import.meta.dir, "../../data");

function initDatabase(): Database {
  const db = new Database(resolve(import.meta.dir, "../instagram.db"));
  db.exec("PRAGMA journal_mode = WAL");

  const schema = readFileSync(resolve(dataDir, "schema.sql"), "utf-8");
  db.exec(schema);

  // Seed if empty
  const count = db.query("SELECT COUNT(*) as n FROM users").get() as any;
  if (count.n === 0) {
    const seed = readFileSync(resolve(dataDir, "seed.sql"), "utf-8");
    db.exec(seed);
    console.log("Database seeded");
  } else {
    // Upgrade path for databases created before DM support: the schema adds
    // the (empty) conversations/messages tables, so replay just the DM
    // section of the seed file into them.
    const dms = db.query("SELECT COUNT(*) as n FROM conversations").get() as any;
    if (dms.n === 0) {
      const seed = readFileSync(resolve(dataDir, "seed.sql"), "utf-8");
      const marker = seed.indexOf("-- Direct message conversations");
      if (marker !== -1) {
        db.exec(seed.slice(marker));
        console.log("Database upgraded with DM seed data");
      }
    }
  }

  return db;
}

export const db = initDatabase();
