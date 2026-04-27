// Cross-SDK compatibility runner for the engine's portable pure
// helpers, as exposed via the wasm-bindgen exports in
// `@hypen-space/server/wasm-node/hypen_engine.js`. Every fixture
// under `engine-compatibility-tests/fixtures/portable/` is fed
// through the TypeScript binding and must produce byte-equal output
// to the Rust engine.

import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as wasm from "../../../hypen-web/packages/server/wasm-node/hypen_engine.js";

interface PortableFixture {
  name: string;
  description: string;
  function: string;
  input: unknown;
  expected: unknown;
}

const fixturesRoot = join(import.meta.dir, "../../fixtures/portable");

async function loadFixtures(): Promise<PortableFixture[]> {
  const out: PortableFixture[] = [];
  const categories = await readdir(fixturesRoot);
  for (const cat of categories) {
    const files = await readdir(join(fixturesRoot, cat));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(join(fixturesRoot, cat, file), "utf-8");
      out.push(JSON.parse(raw));
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function canon(v: any): any {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canon);
  const keys = Object.keys(v).sort();
  const out: Record<string, any> = {};
  for (const k of keys) out[k] = canon(v[k]);
  return out;
}

describe("portable helpers — cross-SDK fixtures", async () => {
  const fixtures = await loadFixtures();

  for (const fx of fixtures) {
    test(fx.name, () => {
      switch (fx.function) {
        case "diff_paths": {
          const input = fx.input as { old: any; new: any };
          const raw = wasm.diffPaths(
            JSON.stringify(input.old),
            JSON.stringify(input.new),
          );
          const got = JSON.parse(raw);
          // Order-insensitive: sort by path.
          const gotSorted = [...got].sort((a, b) =>
            String(a.path).localeCompare(String(b.path)),
          );
          const wantSorted = [...(fx.expected as any[])].sort((a, b) =>
            String(a.path).localeCompare(String(b.path)),
          );
          expect(canon(gotSorted)).toEqual(canon(wantSorted));
          break;
        }
        case "match_path": {
          const input = fx.input as { pattern: string; path: string };
          const got = JSON.parse(wasm.matchPath(input.pattern, input.path));
          expect(canon(got)).toEqual(canon(fx.expected));
          break;
        }
        case "session_step": {
          const input = fx.input as { state: any; event: any };
          const got = JSON.parse(
            wasm.sessionStep(
              JSON.stringify(input.state),
              JSON.stringify(input.event),
            ),
          );
          expect(canon(got)).toEqual(canon(fx.expected));
          break;
        }
        case "path_get": {
          const input = fx.input as { value: any; path: string };
          const got = JSON.parse(
            wasm.pathGet(JSON.stringify(input.value), input.path),
          );
          expect(deepEqual(got, fx.expected)).toBe(true);
          break;
        }
        case "path_has": {
          const input = fx.input as { value: any; path: string };
          const got =
            wasm.pathHas(JSON.stringify(input.value), input.path) === "true";
          expect(got).toBe(fx.expected as boolean);
          break;
        }
        case "path_set": {
          const input = fx.input as {
            value: any;
            path: string;
            new_value: any;
          };
          const got = JSON.parse(
            wasm.pathSet(
              JSON.stringify(input.value),
              input.path,
              JSON.stringify(input.new_value),
            ),
          );
          expect(canon(got)).toEqual(canon(fx.expected));
          break;
        }
        case "path_delete": {
          const input = fx.input as { value: any; path: string };
          const got = JSON.parse(
            wasm.pathDelete(JSON.stringify(input.value), input.path),
          );
          expect(canon(got)).toEqual(canon(fx.expected));
          break;
        }
        case "encode_uri_component": {
          const got = wasm.encodeUriComponent(fx.input as string);
          expect(got).toBe(fx.expected as string);
          break;
        }
        case "decode_uri_component": {
          const got = wasm.decodeUriComponent(fx.input as string);
          expect(got).toBe(fx.expected as string);
          break;
        }
        case "parse_query": {
          const got = JSON.parse(wasm.parseQuery(fx.input as string));
          expect(canon(got)).toEqual(canon(fx.expected));
          break;
        }
        case "build_url": {
          const input = fx.input as {
            path: string;
            query: Record<string, string>;
          };
          const got = wasm.buildUrl(input.path, JSON.stringify(input.query));
          expect(got).toBe(fx.expected as string);
          break;
        }
        default:
          throw new Error(`unknown portable function: ${fx.function}`);
      }
    });
  }
});
