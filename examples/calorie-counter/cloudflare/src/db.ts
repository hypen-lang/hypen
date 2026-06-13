/**
 * bun:sqlite-compatible shim over a Durable Object's synchronous
 * SQLite storage (`state.storage.sql`).
 *
 * The existing modules + queries.ts were written against bun:sqlite's
 *
 *   db.query(sql).all(...args)   // → row[]
 *   db.query(sql).get(...args)   // → row | undefined
 *   db.query(sql).run(...args)   // → void
 *   db.exec(multiStatementSql)
 *
 * surface. Cloudflare DO SQLite (`state.storage.sql`) exposes the same
 * synchronous semantics via `sql.exec(query, ...bindings)`. We just
 * adapt the shape.
 *
 * The shim holds a module-level binding (`_sql`) that the DO's
 * constructor wires up via `bindSql(state.storage.sql)` before anyone
 * else can touch the `db` export. A single DO instance is
 * single-threaded so a module-level variable is safe; the engine and
 * module instances live entirely inside the DO that bound it.
 */

interface SqlStorageCursor {
  toArray(): Record<string, unknown>[];
  one?(): Record<string, unknown>;
  raw?(): IterableIterator<unknown[]>;
}

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
}

interface DOStorage {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

let _sql: SqlStorage | null = null;
let _storage: DOStorage | null = null;

export function bindSql(storageOrSql: DOStorage | SqlStorage): void {
  if ("transactionSync" in storageOrSql) {
    _storage = storageOrSql as DOStorage;
    _sql = (storageOrSql as DOStorage).sql;
  } else {
    _sql = storageOrSql as SqlStorage;
    _storage = null;
  }
}

function requireSql(): SqlStorage {
  if (!_sql) {
    throw new Error(
      "DO SQLite not bound. Call bindSql(state.storage.sql) in the DO constructor before importing modules that use the db."
    );
  }
  return _sql;
}

class Statement {
  constructor(private readonly sql: string) {}

  all<T = Record<string, unknown>>(...args: unknown[]): T[] {
    return requireSql().exec(this.sql, ...args).toArray() as T[];
  }

  get<T = Record<string, unknown>>(...args: unknown[]): T | undefined {
    const rows = requireSql().exec(this.sql, ...args).toArray();
    return rows.length > 0 ? (rows[0] as T) : undefined;
  }

  run(...args: unknown[]): void {
    requireSql().exec(this.sql, ...args);
  }
}

interface PreparedStatement {
  run(...args: unknown[]): void;
}

export const db = {
  /** Mirrors bun:sqlite Database.query — lazy, statement-ish. */
  query(sql: string): Statement {
    return new Statement(sql);
  },

  /**
   * Mirrors bun:sqlite Database.prepare. We don't compile-prepare —
   * DO SQLite caches statements internally — but we return the same
   * `.run(...)` shape so call sites that switch between `.query()`
   * and `.prepare()` continue to work.
   */
  prepare(sql: string): PreparedStatement {
    return new Statement(sql);
  },

  /**
   * Run multi-statement SQL (used for schema + seed). DO SQLite's
   * `exec()` already accepts multiple statements separated by ";"
   * within a single call.
   */
  exec(sql: string): void {
    requireSql().exec(sql);
  },

  /**
   * Mirrors bun:sqlite Database.transaction — returns a callable that
   * wraps the body in a transaction. DO SQLite auto-batches writes
   * within a single tick (and `exec()` calls inside the same JS
   * microtask already run atomically), but we still wrap explicitly
   * with SAVEPOINT so a thrown error rolls back cleanly.
   */
  transaction<T extends (...args: any[]) => any>(body: T): T {
    return ((...args: unknown[]) => {
      requireSql(); // ensure binding present
      if (_storage?.transactionSync) {
        return _storage.transactionSync(() => body(...args));
      }
      // Fallback (shouldn't trigger inside a DO) — just run inline.
      return body(...args);
    }) as unknown as T;
  },
};

export type Db = typeof db;
