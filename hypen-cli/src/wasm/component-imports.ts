/**
 * What a built component actually imports, read from its bytes.
 *
 * A WebAssembly Component lists its imports in top-level import sections
 * (`hypen:storage/app@0.1.0`, `wasi:http/outgoing-handler@0.2.3`, …). The
 * host decides at link time whether to provide each one, so the imports are
 * the ground truth of which *link-time* capabilities a module needs —
 * storage tiers and HTTP. (`reads` / `dispatches` targets are not in the
 * bytes: they are module names the author chose, passed at run time through
 * `hypen:engine/state`.)
 *
 * This is a reader for exactly that: section framing plus the import
 * section's entries. No dependency, no instantiation, nothing executed.
 */

import type { StorageTier } from "./module-package.js";

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array, private readonly end: number = bytes.length) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  byte(): number {
    if (this.pos >= this.end) throw new RangeError("unexpected end of component");
    return this.bytes[this.pos++] as number;
  }

  /** Unsigned LEB128 (u32). */
  u32(): number {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      if (shift > 28) throw new RangeError("LEB128 too long");
    }
  }

  /** Skip a signed LEB128 (a type index or a primitive type code). */
  skipLeb(): void {
    while ((this.byte() & 0x80) !== 0) {
      /* continuation */
    }
  }

  name(): string {
    const length = this.u32();
    if (this.pos + length > this.end) throw new RangeError("name runs past the section");
    const text = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return text;
  }

  sub(length: number): Reader {
    if (this.pos + length > this.end) throw new RangeError("section runs past the file");
    const reader = new Reader(this.bytes, this.pos + length);
    reader.pos = this.pos;
    this.pos += length;
    return reader;
  }
}

const IMPORT_SECTION = 10;

/** Skip an `externdesc` (what kind of thing an import is). */
function skipExternDesc(r: Reader): void {
  const kind = r.byte();
  switch (kind) {
    case 0x00: // core module: 0x11 + core type index
      r.byte();
      r.u32();
      return;
    case 0x01: // func
    case 0x04: // component
    case 0x05: // instance
      r.u32();
      return;
    case 0x02: // value: bound (0x00 eq valueidx | 0x01 valtype)
      r.byte();
      r.skipLeb();
      return;
    case 0x03: // type: bound (0x00 eq typeidx | 0x01 sub resource)
      if (r.byte() === 0x00) r.u32();
      return;
    default:
      throw new RangeError(`unknown extern kind 0x${kind.toString(16)}`);
  }
}

/**
 * The names a component imports at its top level, as written (with their
 * `@version`). Returns `null` when `bytes` is not a component or its import
 * sections cannot be read — callers treat that as "unknown", never as "none".
 */
export function readComponentImports(bytes: Uint8Array): string[] | null {
  const magic = [0x00, 0x61, 0x73, 0x6d];
  if (bytes.length < 8 || magic.some((b, i) => bytes[i] !== b)) return null;
  if (((bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8)) !== 1) return null;
  const imports: string[] = [];
  try {
    const r = new Reader(bytes);
    r.pos = 8;
    while (!r.done) {
      const id = r.byte();
      const section = r.sub(r.u32());
      if (id !== IMPORT_SECTION) continue;
      const count = section.u32();
      for (let i = 0; i < count; i++) {
        // importname: a discriminant byte (0x00 plain / 0x01 interface in
        // older encodings), then the name.
        section.byte();
        imports.push(section.name());
        skipExternDesc(section);
      }
    }
  } catch {
    return null;
  }
  return imports;
}

/** Strip a `@x.y.z` version suffix. */
export const unversioned = (name: string): string => name.replace(/@[^/]*$/, "");

/** The link-time capabilities a set of imports needs. */
export interface LinkRequirements {
  storage: StorageTier[];
  /** `wasi:http/*` or `hypen:http/deferred`; the import that needs it. */
  http: string | null;
  /** Imports `hypen:engine/state` (reads / dispatches / subscriptions). */
  engineState: boolean;
}

/** The single mapping from import names to capabilities. */
export function linkRequirements(imports: readonly string[]): LinkRequirements {
  const names = imports.map(unversioned);
  const storage: StorageTier[] = [];
  if (names.includes("hypen:storage/app")) storage.push("app");
  if (names.includes("hypen:storage/cloud")) storage.push("cloud");
  return {
    storage,
    http: names.find((n) => n === "hypen:http/deferred" || n.startsWith("wasi:http/")) ?? null,
    engineState: names.includes("hypen:engine/state"),
  };
}
