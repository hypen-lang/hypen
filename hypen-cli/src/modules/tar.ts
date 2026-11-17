/**
 * Extracting a module tarball (`npm pack` / `bun pm pack` output, or any
 * `.tgz` of a package directory) — safely. A tarball is untrusted input:
 * an entry named `../../.ssh/authorized_keys`, an absolute path, or a
 * symlink followed by a write through it would put files outside the
 * extraction directory (zip-slip). So:
 *
 * - the target directory must not exist (a fresh directory, never a merge);
 * - only regular files and directories are created; links, devices and
 *   FIFOs are refused, not skipped;
 * - every entry path is checked to stay inside the target, before anything
 *   is written — a bad entry means nothing is extracted.
 *
 * Nothing in the archive is executed.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import { gunzipSync, gzipSync } from "zlib";
import { BuildError } from "../build-error.js";

interface TarEntry {
  path: string;
  type: "file" | "directory";
  data: Uint8Array;
}

const BLOCK = 512;

function field(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

/** `path=…` records of a pax extended header. */
function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  let path: string | undefined;
  for (let pos = 0; pos < text.length; ) {
    const space = text.indexOf(" ", pos);
    if (space === -1) break;
    const length = Number(text.slice(pos, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, pos + length - 1);
    if (record.startsWith("path=")) path = record.slice(5);
    pos += length;
  }
  return path;
}

function unsafe(tarball: string, entry: string, why: string): BuildError {
  return new BuildError(`${tarball}: refusing to extract "${entry}": ${why}.`, {
    code: "TARBALL_UNSAFE",
    file: tarball,
    hint: "this archive is malformed or hostile — do not install it; ask its author for a package built with `hypen pack`",
  });
}

function readEntries(tarball: string, bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let longName: string | undefined;
  for (let pos = 0; pos + BLOCK <= bytes.length; ) {
    const header = bytes.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const data = bytes.subarray(pos + BLOCK, pos + BLOCK + size);
    if (data.length !== size) {
      throw new BuildError(`${tarball} is truncated.`, { code: "TARBALL_INVALID", file: tarball, hint: "download or pack it again" });
    }
    pos += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    if (type === "x") {
      longName = paxPath(data);
      continue;
    }
    if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0+$/, "");
      continue;
    }
    longName = undefined;
    if (type === "g") continue; // global pax header: no file
    if (type === "0" || type === "\0") entries.push({ path, type: "file", data });
    else if (type === "5") entries.push({ path, type: "directory", data: new Uint8Array() });
    else {
      const what = type === "1" ? "a hard link" : type === "2" ? "a symbolic link" : `a special file (type "${type}")`;
      throw unsafe(tarball, path, `it is ${what}; a module package holds only regular files`);
    }
  }
  return entries;
}

/**
 * Extract `tarball` into the new directory `target`, stripping the single
 * top-level directory npm tarballs have (`package/`).
 *
 * @throws {BuildError} `TARBALL_INVALID` (not a gzip'd tar, truncated,
 *   empty), `TARBALL_UNSAFE` (an entry that escapes `target`, or a link),
 *   `CONFIG_NOT_WRITABLE` when `target` already exists.
 * @returns the extracted files, relative to `target`.
 */
export function extractTarball(tarball: string, target: string): string[] {
  let bytes: Uint8Array;
  try {
    bytes = gunzipSync(readFileSync(tarball));
  } catch (cause) {
    throw new BuildError(`${tarball} is not a gzip-compressed tarball: ${cause instanceof Error ? cause.message : String(cause)}`, {
      code: "TARBALL_INVALID",
      file: tarball,
      hint: "pass a .tgz made by `npm pack` / `bun pm pack` in a `hypen pack` output directory",
      cause,
    });
  }
  const entries = readEntries(tarball, bytes);
  if (!entries.some((e) => e.type === "file")) {
    throw new BuildError(`${tarball} contains no files.`, { code: "TARBALL_INVALID", file: tarball, hint: "pack it again" });
  }
  // npm tarballs wrap everything in one directory; strip it when every
  // entry shares it.
  const tops = new Set(entries.map((e) => e.path.replace(/^\.\//, "").split("/")[0]));
  const strip = tops.size === 1 && entries.every((e) => e.path.replace(/^\.\//, "").includes("/") || e.type === "directory");
  const root = resolve(target);
  const planned: Array<{ entry: TarEntry; to: string }> = [];
  for (const entry of entries) {
    const clean = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (clean.startsWith("/") || isAbsolute(entry.path) || /^[A-Za-z]:/.test(clean)) {
      throw unsafe(tarball, entry.path, "it has an absolute path");
    }
    if (clean.split("/").includes("..")) throw unsafe(tarball, entry.path, 'its path contains ".."');
    const inner = strip ? clean.split("/").slice(1).join("/") : clean;
    if (inner === "") continue;
    const to = resolve(root, inner);
    const rel = relative(root, to);
    if (rel.startsWith("..") || isAbsolute(rel)) throw unsafe(tarball, entry.path, "it resolves outside the extraction directory");
    planned.push({ entry, to });
  }
  if (existsSync(root)) {
    throw new BuildError(`${root} already exists; a tarball is only ever extracted into a fresh directory.`, {
      code: "CONFIG_NOT_WRITABLE",
      file: root,
      hint: "remove that directory (after checking nothing in it is yours), or `hypen remove` the package first",
    });
  }
  mkdirSync(root, { recursive: true });
  try {
    for (const { entry, to } of planned) {
      if (entry.type === "directory") mkdirSync(to, { recursive: true });
      else {
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, entry.data);
      }
    }
  } catch (cause) {
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
  return planned.filter((p) => p.entry.type === "file").map((p) => relative(root, p.to));
}

/** Build a gzip'd ustar archive (tests, and nothing else). */
export function tarballOf(files: ReadonlyArray<{ path: string; data: Uint8Array | string; type?: "0" | "1" | "2" | "5"; link?: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const file of files) {
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const header = new Uint8Array(BLOCK);
    const put = (text: string, offset: number, length: number) => header.set(encoder.encode(text).subarray(0, length), offset);
    put(file.path, 0, 100);
    put("0000644\0", 100, 8);
    put("0000000\0", 108, 8);
    put("0000000\0", 116, 8);
    put(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    put("00000000000\0", 136, 12);
    put("        ", 148, 8);
    put(file.type ?? "0", 156, 1);
    if (file.link) put(file.link, 157, 100);
    put("ustar\0" + "00", 257, 8);
    let sum = 0;
    for (const b of header) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, data, new Uint8Array((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const total = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const block of blocks) {
    total.set(block, offset);
    offset += block.length;
  }
  return gzipSync(total);
}

