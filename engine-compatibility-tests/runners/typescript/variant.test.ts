// Cross-SDK compatibility runner for the renderer-side variant parser /
// resolver, exercised through the REAL shared web implementation
// `@hypen-space/web` `variants.ts` (which backs both the DOM and Canvas
// renderers). Every fixture under `engine-compatibility-tests/fixtures/variant/`
// is fed through `parseVariantKey` / `resolveVariantProps` and must produce the
// same output as the Rust engine helper (see runners/rust/tests/variant.rs) —
// this is the contract that keeps the web parser from drifting from the engine.

import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseVariantKey,
  resolveVariantProps,
  type ActiveStates,
} from "../../../hypen-web/packages/web/src/variants.ts";

interface VariantFixture {
  name: string;
  description: string;
  function: "parse_prop_key" | "resolve_variant";
  input: any;
  expected: unknown;
}

const fixturesRoot = join(import.meta.dir, "../../fixtures/variant");

async function loadFixtures(): Promise<VariantFixture[]> {
  const out: VariantFixture[] = [];
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

function canon(v: any): any {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canon);
  const keys = Object.keys(v).sort();
  const out: Record<string, any> = {};
  for (const k of keys) out[k] = canon(v[k]);
  return out;
}

describe("variant parser/resolver — cross-SDK fixtures (web variants.ts)", async () => {
  const fixtures = await loadFixtures();

  for (const fx of fixtures) {
    test(fx.name, () => {
      switch (fx.function) {
        case "parse_prop_key": {
          const got = parseVariantKey(fx.input.key as string);
          expect(canon(got)).toEqual(canon(fx.expected));
          break;
        }
        case "resolve_variant": {
          const base = fx.input.base as string;
          const props = fx.input.props as Record<string, unknown>;
          const width = fx.input.width as number;
          const states: ActiveStates = {};
          for (const s of fx.input.activeStates as string[]) {
            (states as Record<string, boolean>)[s] = true;
          }
          const resolved = resolveVariantProps(props, width, states);
          // A base with no applicable entry is absent from the result; mirror the
          // Rust runner's `None -> null`.
          const got = base in resolved ? resolved[base] : null;
          expect(canon(got)).toEqual(canon(fx.expected));
          break;
        }
        default:
          throw new Error(`unknown variant fixture function: ${fx.function}`);
      }
    });
  }
});
