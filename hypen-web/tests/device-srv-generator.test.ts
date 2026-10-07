/**
 * Device type generator (#13): the runtime validator interprets a fixed
 * keyword subset, so generation must FAIL on anything else instead of
 * silently ignoring it; a second shipped revision of a capability gets its
 * own validator while the typed capability map keeps ONE entry per name.
 * (What a server advertises is not generated: it is the Rust broker's
 * `server_advertisement`, see device-srv-typed-api.test.ts.)
 */

import { describe, expect, test, afterEach } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMAS = resolve(import.meta.dir, "../../engine-compatibility-tests/schema/device");
const GENERATOR = resolve(import.meta.dir, "../scripts/generate-device-types.ts");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): { schemas: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "hypen-devgen-"));
  dirs.push(dir);
  const schemas = join(dir, "schemas");
  cpSync(SCHEMAS, schemas, { recursive: true });
  return { schemas, out: join(dir, "generated.ts") };
}

function generate(schemas: string, out: string) {
  return spawnSync("bun", [GENERATOR], {
    encoding: "utf-8",
    env: { ...process.env, HYPEN_DEVICE_SCHEMA_DIR: schemas, HYPEN_DEVICE_GENERATED_OUT: out },
  });
}

function editSchema(schemas: string, file: string, edit: (json: any) => void): void {
  const path = join(schemas, file);
  const json = JSON.parse(readFileSync(path, "utf-8"));
  edit(json);
  writeFileSync(path, JSON.stringify(json, null, 2));
}

describe("generator keyword audit", () => {
  test("the checked-in schemas generate cleanly", () => {
    const { schemas, out } = scratch();
    const r = generate(schemas, out);
    expect(r.status).toBe(0);
  });

  for (const [keyword, value] of [
    ["format", "email"],
    ["if", { type: "string" }],
    ["allOf", [{ type: "string" }]],
    ["multipleOf", 2],
    ["patternProperties", { "^x": { type: "string" } }],
    ["dependentRequired", {}],
  ] as const) {
    test(`unsupported keyword "${keyword}" fails generation`, () => {
      const { schemas, out } = scratch();
      editSchema(schemas, "permission.query-v1.schema.json", (json) => {
        json.$defs.params.properties.permission[keyword] = value;
      });
      const r = generate(schemas, out);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`keyword "${keyword}"`);
    });
  }

  test("an unsupported type (number) fails generation", () => {
    const { schemas, out } = scratch();
    editSchema(schemas, "permission.query-v1.schema.json", (json) => {
      json.$defs.params.properties.permission = { type: "number" };
    });
    const r = generate(schemas, out);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("type");
  });
});

describe("sibling keywords are evaluated, never hidden (#11)", () => {
  // A scratch generation whose permission.query params put constraints next
  // to $ref / enum / const / not / anyOf; the emitted validator must enforce
  // every one of them.
  test("constraints beside $ref/enum/const/not/anyOf all apply", async () => {
    const { schemas, out } = scratch();
    editSchema(schemas, "permission.query-v1.schema.json", (json) => {
      json.$defs.tag = { type: "string", maxLength: 8 };
      json.$defs.params = {
        type: "object",
        additionalProperties: false,
        required: ["a", "b", "c", "d"],
        properties: {
          a: { $ref: "#/$defs/tag", minLength: 3 },
          b: { enum: ["x", "yy", "zzz"], type: "string", minLength: 2 },
          c: { const: 5, type: "integer", minimum: 6 },
          d: { anyOf: [{ type: "string" }, { type: "integer" }], not: { const: "no" } },
        },
      };
    });
    const r = generate(schemas, out);
    expect(r.status).toBe(0);
    const mod = await import(out);
    const check = (params: unknown) => mod.validateCapabilityPayload("permission.query", 1, "params", params);
    expect(check({ a: "abc", b: "yy", c: 5, d: 1 }).map((v: any) => v.message)).toEqual(["below minimum 6"]);
    expect(check({ a: "ab", b: "yy", c: 5, d: 1 }).some((v: any) => v.message === "shorter than 3")).toBe(true);
    expect(check({ a: "abc", b: "x", c: 5, d: 1 }).some((v: any) => v.message === "shorter than 2")).toBe(true);
    expect(check({ a: "abc", b: "yy", c: 5, d: "no" }).some((v: any) => v.message.includes("(not)"))).toBe(true);
    expect(check({ a: "abc", b: "yy", c: 5, d: true }).some((v: any) => v.message.includes("anyOf"))).toBe(true);
  });
});

describe("a second revision of a capability", () => {
  test("gets its own validator; the typed map keeps one entry per name, never a duplicate", async () => {
    const { schemas, out } = scratch();
    // v2 = v1 with one more media type allowed.
    cpSync(join(schemas, "gallery.pick-v1.schema.json"), join(schemas, "gallery.pick-v2.schema.json"));
    editSchema(schemas, "gallery.pick-v2.schema.json", (json) => {
      json.$id = json.$id.replace("-v1.", "-v2.");
      json.title = json.title.replace("revision 1", "revision 2");
      json.$defs.params.properties.mediaTypes.items.enum.push("audio");
      json.$defs.params.properties.mediaTypes.maxItems = 3;
    });
    const r = generate(schemas, out);
    expect(r.status).toBe(0);
    const src = readFileSync(out, "utf-8");
    expect([...src.matchAll(/^  "gallery\.pick": \{$/gm)].length).toBe(1);
    expect(src).not.toContain("GENERATED_CAPABILITIES");
    const mod = await import(out);
    const audio = { mediaTypes: ["audio"], maxCount: 1 };
    expect(mod.validateCapabilityPayload("gallery.pick", 1, "params", audio)).not.toEqual([]);
    expect(mod.validateCapabilityPayload("gallery.pick", 2, "params", audio)).toEqual([]);
  });
});

describe("typed capability map (round 3, RFC 001 §4)", () => {
  const GENERATED = resolve(import.meta.dir, "../packages/core/src/remote/device/generated.ts");

  /** name → the map entry's text, parsed from emitted source. */
  function mapEntries(src: string): Map<string, string> {
    const body = src.slice(src.indexOf("export interface DeviceCapabilityMap {"));
    const out = new Map<string, string>();
    for (const m of body.matchAll(/^  "([^"]+)": \{\n([\s\S]*?)^  \};/gm)) out.set(m[1]!, m[2]!);
    return out;
  }

  test("one entry per registry capability, keyed on its latest revision, with the registry's mode/data/lifetimes", () => {
    const src = readFileSync(GENERATED, "utf-8");
    const registry = JSON.parse(readFileSync(join(SCHEMAS, "registry-v1.json"), "utf-8"));
    const entries = mapEntries(src);
    expect([...entries.keys()].sort()).toEqual(registry.capabilities.map((c: any) => c.name).sort());
    for (const cap of registry.capabilities) {
      const rev = cap.revisions.at(-1);
      const text = entries.get(cap.name)!;
      expect(text).toContain(`version: ${rev.version};`);
      expect(text).toContain(`mode: "${rev.mode}";`);
      expect(text).toContain(`data: "${rev.data}";`);
      expect(text).toContain(`lifetimes: ${rev.lifetimes.map((l: string) => `"${l}"`).join(" | ")};`);
    }
    expect(entries.get("camera.capture")).toContain("params: CameraCaptureV1Params;");
    expect(entries.get("mic.record")).toContain("result: MicRecordV1Result;");
    expect(entries.get("bluetooth.select")).toContain("event: BluetoothSelectV1Event;");
  });

  test("the closed permission union is emitted from permission.query's schema", async () => {
    const src = readFileSync(GENERATED, "utf-8");
    expect(src).toContain('export type DevicePermission = PermissionQueryV1Params["permission"];');
    const mod = await import(GENERATED);
    const schema = JSON.parse(readFileSync(join(SCHEMAS, "permission.query-v1.schema.json"), "utf-8"));
    expect(mod.DEVICE_PERMISSIONS).toEqual(schema.$defs.params.properties.permission.enum);
  });

  test("a revision with a schema but no registry entry stays out of the map (latest registered wins)", () => {
    const { schemas, out } = scratch();
    cpSync(join(schemas, "gallery.pick-v1.schema.json"), join(schemas, "gallery.pick-v2.schema.json"));
    const r = generate(schemas, out);
    expect(r.status).toBe(0);
    expect(mapEntries(readFileSync(out, "utf-8")).get("gallery.pick")).toContain("version: 1;");
  });

  test("a registered second revision becomes the map's typed revision", () => {
    const { schemas, out } = scratch();
    cpSync(join(schemas, "gallery.pick-v1.schema.json"), join(schemas, "gallery.pick-v2.schema.json"));
    const regPath = join(schemas, "registry-v1.json");
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    const gp = reg.capabilities.find((c: any) => c.name === "gallery.pick");
    gp.revisions.push({ ...gp.revisions[0], version: 2 });
    writeFileSync(regPath, JSON.stringify(reg));
    const r = generate(schemas, out);
    expect(r.status).toBe(0);
    const entry = mapEntries(readFileSync(out, "utf-8")).get("gallery.pick")!;
    expect(entry).toContain("version: 2;");
    expect(entry).toContain("params: GalleryPickV2Params;");
  });

  test("a missing or malformed registry fails generation (never a silently untyped map)", () => {
    const a = scratch();
    rmSync(join(a.schemas, "registry-v1.json"));
    const r1 = generate(a.schemas, a.out);
    expect(r1.status).not.toBe(0);
    expect(r1.stderr).toContain("registry-v1.json");

    const b = scratch();
    const regPath = join(b.schemas, "registry-v1.json");
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    reg.capabilities[0].revisions[0].mode = "bidirectional";
    writeFileSync(regPath, JSON.stringify(reg));
    const r2 = generate(b.schemas, b.out);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("malformed revision");
  });
});

describe("small closed integer ranges are literal unions", () => {
  test("the checked-in mic.record channels is `1 | 2`; single-value channels are the literal; wide ranges stay number", () => {
    const src = readFileSync(resolve(import.meta.dir, "../packages/core/src/remote/device/generated.ts"), "utf-8");
    const iface = (name: string) => src.match(new RegExp(`export interface ${name} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(iface("MicRecordV1Params")).toContain("channels?: 1 | 2;");
    expect(iface("MicRecordV1Params")).toContain("sampleRate: number;"); // 8000..192000
    expect(iface("MicRecordV1Params")).toContain("maxDurationMs?: number;");
    expect(iface("MicRecordV1BlobItem")).toContain("channel: 0;");
    expect(iface("CameraCaptureV1BlobStart")).toContain("channel: 0;");
    expect(iface("GalleryPickV1Params")).toContain("maxCount: number;"); // 1..16: wider than the bound
  });

  test("inclusive/exclusive bounds combine to the tightest range; open or wide ranges are number; empty is never", () => {
    const { schemas, out } = scratch();
    editSchema(schemas, "permission.query-v1.schema.json", (json) => {
      json.$defs.params = {
        type: "object",
        additionalProperties: false,
        required: ["a", "b", "c", "d", "e", "f", "g"],
        properties: {
          a: { type: "integer", minimum: -1, maximum: 1 },
          b: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 4 },
          c: { type: "integer", minimum: 0, exclusiveMinimum: 2, maximum: 9, exclusiveMaximum: 5 },
          d: { type: "integer", minimum: 1, maximum: 8 }, // 8 values: at the bound
          e: { type: "integer", minimum: 1, maximum: 9 }, // 9 values: number
          f: { type: "integer", minimum: 0 },
          g: { type: "integer", minimum: 3, maximum: 2 },
        },
      };
    });
    const r = generate(schemas, out);
    expect(r.status).toBe(0);
    const src = readFileSync(out, "utf-8");
    const body = src.match(/export interface PermissionQueryV1Params \{([^}]*)\}/)?.[1] ?? "";
    expect(body).toContain("a: -1 | 0 | 1;");
    expect(body).toContain("b: 1 | 2 | 3;");
    expect(body).toContain("c: 3 | 4;");
    expect(body).toContain("d: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;");
    expect(body).toContain("e: number;");
    expect(body).toContain("f: number;");
    expect(body).toContain("g: never;");
  });
});
