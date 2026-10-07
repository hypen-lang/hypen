/**
 * The Files app's storage: a small per-visitor drive in the Durable Object's
 * own SQLite.
 *
 * Every visitor gets their own Durable Object (the worker routes on the
 * `hypen_home` cookie, see worker.ts), so "whose files are these" is simply
 * "which DO is this". Handlers never hold that as a module-level global:
 * several DOs can share one isolate and interleave across `await`s (a file
 * pick waits on the user for seconds), so a rebind-per-message global could
 * hand one visitor's upload to another. Instead the DO runs every entry
 * point inside `driveScope.run({ storage, bucket, prefix }, …)` and handlers read it
 * through `AsyncLocalStorage`, which follows their own async continuations.
 *
 * Folders and files share one `drive_nodes` table in the DO's SQLite; file
 * bytes live in the `FILES` R2 bucket under `drive/<durable object id>/<file
 * id>`. Only this DO's metadata can name an object, so a visitor can reach
 * nothing but their own files.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
export interface DriveStorage {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
  transactionSync<T>(fn: () => T): T;
}

/** The subset of an R2 bucket binding the drive uses. */
export interface DriveBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** Everything one visitor's drive needs: their DO's SQLite and their R2 prefix. */
export interface DriveScope {
  storage: DriveStorage;
  bucket: DriveBucket;
  /** `drive/<durable object id>/` */
  prefix: string;
}

export const driveScope = new AsyncLocalStorage<DriveScope>();

/**
 * Thumbnail URL for a file in the current drive: `/drive/<DO id>/<file id>`.
 * The DO id routes it without the visitor cookie (native shells have no
 * cookie jar), and it says nothing about that cookie. Both ids are random,
 * so the URL is an unguessable link to that one image.
 */
export function previewPath(fileId: string): string {
  const prefix = driveScope.getStore()?.prefix;
  if (!prefix) throw new Error("previewPath called outside driveScope.run");
  return `/${prefix}${fileId}`;
}

/** Largest single file we keep (the device plane retains ≤ 16 MiB per upload batch). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Per-visitor quota. */
export const MAX_DRIVE_BYTES = 200 * 1024 * 1024;
const MAX_NAME = 120;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drive_nodes (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drive_parent ON drive_nodes(parent_id);
`;

const ready = new WeakSet<object>();

/**
 * The drive of the Durable Object this code is running for. Throws outside a
 * `driveScope.run` — never silently falls back to some other visitor's DO.
 */
export function currentDrive(): Drive {
  const scope = driveScope.getStore();
  if (!scope) throw new Error("drive used outside a Durable Object scope");
  if (!ready.has(scope.storage)) {
    scope.storage.sql.exec(SCHEMA);
    // Drives created before "Date Modified" existed lack the column; add it
    // once (the ALTER throws "duplicate column" on every later start).
    try {
      scope.storage.sql.exec("ALTER TABLE drive_nodes ADD COLUMN modified_at INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Already there.
    }
    ready.add(scope.storage);
  }
  return new Drive(scope);
}

export interface DriveNode {
  id: string;
  parentId: string;
  name: string;
  kind: "folder" | "file";
  contentType: string;
  bytes: number;
  createdAt: number;
  /** Last rename/move, or (for a folder) last change to what it holds. */
  modifiedAt: number;
  /** Direct children (folders only; 0 for files). */
  childCount: number;
}

export interface Crumb {
  id: string;
  name: string;
}

/** Root folder id (also the breadcrumb drop-zone id, so it must be non-empty). */
export const ROOT = "root";

function rowToNode(r: Record<string, unknown>): DriveNode {
  return {
    id: r.id as string,
    parentId: r.parent_id as string,
    name: r.name as string,
    kind: r.kind === "folder" ? "folder" : "file",
    contentType: (r.content_type as string) ?? "",
    bytes: Number(r.bytes ?? 0),
    createdAt: Number(r.created_at ?? 0),
    modifiedAt: Number(r.modified_at || r.created_at || 0),
    childCount: Number(r.child_count ?? 0),
  };
}

/**
 * A file or folder name safe to store and show: no path separators, control
 * or bidi/format characters (so "invoice‮fdp.exe" cannot pose as a
 * PDF), trimmed and bounded.
 */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\\/\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, "_").trim();
  const bounded = [...cleaned].slice(0, MAX_NAME).join("");
  return bounded === "." || bounded === ".." ? "_" : bounded;
}

export class Drive {
  private readonly storage: DriveStorage;
  private readonly bucket: DriveBucket;
  private readonly prefix: string;

  constructor(scope: DriveScope) {
    this.storage = scope.storage;
    this.bucket = scope.bucket;
    this.prefix = scope.prefix;
  }

  private key(fileId: string): string {
    return `${this.prefix}${fileId}`;
  }

  private all(query: string, ...args: unknown[]): Record<string, unknown>[] {
    return this.storage.sql.exec(query, ...args).toArray();
  }

  get(id: string): DriveNode | null {
    const row = this.all("SELECT * FROM drive_nodes WHERE id = ?", id)[0];
    return row ? rowToNode(row) : null;
  }

  /** Whether `id` names the root or an existing folder. */
  isFolder(id: string): boolean {
    return id === ROOT || this.get(id)?.kind === "folder";
  }

  /**
   * A folder's children (folders first, then files, each by name), each with
   * its own child count so the browser can show and sort "3 items".
   */
  list(parentId: string): DriveNode[] {
    return this.all(
      `SELECT n.*, (SELECT COUNT(*) FROM drive_nodes c WHERE c.parent_id = n.id) AS child_count
         FROM drive_nodes n WHERE n.parent_id = ? ORDER BY n.kind = 'file', n.name COLLATE NOCASE`,
      parentId
    ).map(rowToNode);
  }

  /** Bump a folder's "Date Modified" (its contents changed). */
  private touch(folderId: string, at = Date.now()): void {
    if (folderId !== ROOT) this.storage.sql.exec("UPDATE drive_nodes SET modified_at = ? WHERE id = ?", at, folderId);
  }

  /** Root → … → `id`, for the breadcrumb bar. */
  path(id: string): Crumb[] {
    const crumbs: Crumb[] = [];
    let cur = id;
    for (let guard = 0; cur !== ROOT && guard < 64; guard++) {
      const node = this.get(cur);
      if (!node) break;
      crumbs.unshift({ id: node.id, name: node.name });
      cur = node.parentId;
    }
    crumbs.unshift({ id: ROOT, name: "My Files" });
    return crumbs;
  }

  usedBytes(): number {
    return Number(this.all("SELECT COALESCE(SUM(bytes), 0) AS total FROM drive_nodes")[0]?.total ?? 0);
  }

  /** `name`, or "name (2).ext", "name (3).ext", … — unique within `parentId`. */
  private uniqueName(parentId: string, name: string, exceptId = ""): string {
    const taken = new Set(
      this.all("SELECT name FROM drive_nodes WHERE parent_id = ? AND id != ?", parentId, exceptId).map((r) =>
        String(r.name).toLowerCase()
      )
    );
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  createFolder(parentId: string, rawName: string): DriveNode | null {
    const name = cleanName(rawName);
    if (!name || !this.isFolder(parentId)) return null;
    const id = `d-${crypto.randomUUID()}`;
    const now = Date.now();
    this.storage.sql.exec(
      "INSERT INTO drive_nodes (id, parent_id, name, kind, created_at, modified_at) VALUES (?, ?, ?, 'folder', ?, ?)",
      id,
      parentId,
      this.uniqueName(parentId, name),
      now,
      now
    );
    this.touch(parentId, now);
    return this.get(id);
  }

  /** Store one uploaded file under `parentId`. The caller has checked sizes. */
  async putFile(parentId: string, rawName: string, contentType: string, bytes: Uint8Array): Promise<DriveNode | null> {
    if (!this.isFolder(parentId)) return null;
    const id = `f-${crypto.randomUUID()}`;
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType.toLowerCase() : "application/octet-stream";
    // Object first, row second: a row never names bytes that aren't there.
    await this.bucket.put(this.key(id), bytes, { httpMetadata: { contentType: type } });
    // Re-check after the await: the folder may have been deleted meanwhile.
    const parent = this.isFolder(parentId) ? parentId : ROOT;
    const now = Date.now();
    this.storage.sql.exec(
      "INSERT INTO drive_nodes (id, parent_id, name, kind, content_type, bytes, created_at, modified_at) VALUES (?, ?, ?, 'file', ?, ?, ?, ?)",
      id,
      parent,
      this.uniqueName(parent, cleanName(rawName) || "Untitled"),
      type,
      bytes.byteLength,
      now,
      now
    );
    this.touch(parent, now);
    return this.get(id);
  }

  async readFile(id: string): Promise<{ node: DriveNode; bytes: Uint8Array } | null> {
    const node = this.get(id);
    if (!node || node.kind !== "file") return null;
    const object = await this.bucket.get(this.key(id));
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    return bytes.byteLength === node.bytes ? { node, bytes } : null;
  }

  /**
   * Move `id` into folder `targetId`. Refuses a move into itself or one of
   * its own descendants (the renderer never rejects such a drop), and a
   * no-op move. Returns whether anything moved.
   */
  move(id: string, targetId: string): boolean {
    const node = this.get(id);
    if (!node || node.parentId === targetId || id === targetId || !this.isFolder(targetId)) return false;
    for (let cur = targetId, guard = 0; cur !== ROOT && guard < 64; guard++) {
      if (cur === id) return false;
      cur = this.get(cur)?.parentId ?? ROOT;
    }
    const now = Date.now();
    this.storage.sql.exec(
      "UPDATE drive_nodes SET parent_id = ?, name = ?, modified_at = ? WHERE id = ?",
      targetId,
      this.uniqueName(targetId, node.name, id),
      now,
      id
    );
    this.touch(node.parentId, now);
    this.touch(targetId, now);
    return true;
  }

  /**
   * Rename `id` in place. The name is cleaned and made unique within its
   * folder ("Notes (2).txt"). Returns the stored name, or null if nothing
   * changed or the name was unusable.
   */
  rename(id: string, rawName: string): string | null {
    const node = this.get(id);
    const name = cleanName(rawName);
    if (!node || !name || name === node.name) return null;
    const unique = this.uniqueName(node.parentId, name, id);
    this.storage.sql.exec("UPDATE drive_nodes SET name = ?, modified_at = ? WHERE id = ?", unique, Date.now(), id);
    return unique;
  }

  /** Delete a file, or a folder with everything inside it. */
  async remove(id: string): Promise<void> {
    const node = this.get(id);
    if (!node) return;
    const objects: string[] = [];
    this.storage.transactionSync(() => {
      const stack = [node];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur.kind === "folder") stack.push(...this.list(cur.id));
        else objects.push(this.key(cur.id));
        this.storage.sql.exec("DELETE FROM drive_nodes WHERE id = ?", cur.id);
      }
      this.touch(node.parentId);
    });
    // R2 deletes up to 1000 keys per call.
    for (let i = 0; i < objects.length; i += 1000) await this.bucket.delete(objects.slice(i, i + 1000));
  }
}

// ---------------------------------------------------------------------------
// Serving previews
// ---------------------------------------------------------------------------

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

/** The image type the bytes really are (never the uploader's claim), or null. */
export function sniffImageType(b: Uint8Array): string | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (ascii(b, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(b, 8, 12))) return "image/avif";
  return null;
}

/**
 * `GET /drive/<id>` → an image file's bytes, for thumbnails. Only real
 * images are served (sniffed, `nosniff`, sandboxed): an uploaded HTML or SVG
 * file must never render as a page on this origin. Everything else is
 * downloaded through the device plane (`file.save`) instead.
 */
export async function servePreview(scope: DriveScope, request: Request): Promise<Response> {
  // `/drive/<DO id>/<file id>`; the worker already routed on the DO id.
  const id = /^\/drive\/(?:[0-9a-f]{64}\/)?(f-[0-9a-f-]{36})$/.exec(new URL(request.url).pathname)?.[1];
  const file = id ? await driveScope.run(scope, () => currentDrive().readFile(id)) : null;
  const type = file ? sniffImageType(file.bytes) : null;
  if (!file || !type) return new Response("Not found", { status: 404 });
  return new Response(file.bytes, {
    headers: {
      "content-type": type,
      "content-length": String(file.bytes.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
