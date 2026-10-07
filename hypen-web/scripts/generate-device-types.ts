/**
 * Device Capability Protocol — TS codegen (RFC 001 §6 Phase 1).
 *
 * Reads the JSON Schemas exported from the Rust declarations
 * (engine-compatibility-tests/schema/device/*.schema.json) and emits
 * packages/core/src/remote/device/generated.ts containing:
 *
 *   1. TypeScript types for every schema definition,
 *   2. the typed capability map (`DeviceCapabilityMap`: latest revision per
 *      capability name → params/result/event types plus the registry's
 *      mode, data plane and lifetimes, read from registry-v1.json) that the
 *      typed server API (`context.device.request/stream`, RFC 001 §4) is
 *      keyed on, and the closed `DevicePermission` union, and
 *   3. dependency-free runtime validators that INTERPRET the embedded
 *      schemas — the validator source of truth is the schema document
 *      itself, so a schema change cannot silently diverge from validation.
 *
 * Bespoke rather than off-the-shelf (json-schema-to-typescript emits types
 * only; ajv would add a runtime dependency to the deliberately zero-dep
 * core package). The supported schema subset is exactly what the Rust
 * exporter produces: closed objects, oneOf, anyOf (capability document
 * roots), $ref into #/$defs, const, enum, bounded integers/strings/arrays
 * (incl. min*, exclusive*, uniqueItems; an integer range of at most
 * SMALL_INTEGER_RANGE values is typed as a literal union), pattern, object-valued
 * additionalProperties, and not/required XOR guards. The runtime validator
 * evaluates EVERY keyword present on a node (a $ref/const/enum/oneOf/anyOf/
 * not never hides its siblings), and any other keyword or type is a hard
 * generator error, on purpose — the validator must never be silently more
 * permissive than the schema. Validation cost is linear in the value
 * (maxItems is enforced before per-item work; uniqueItems is one Set pass).
 * String lengths are counted in Unicode code points (JSON Schema semantics).
 *
 * Usage:  bun scripts/generate-device-types.ts [--check]
 *   --check: exit 1 if the checked-in file differs (CI gate; also enforced
 *   by tests/device-generated.test.ts).
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

// Overridable for the generator's own tests (e.g. feeding it a schema with
// an unsupported keyword); the defaults are the checked-in locations.
const SCHEMA_DIR = process.env.HYPEN_DEVICE_SCHEMA_DIR
  ? resolve(process.env.HYPEN_DEVICE_SCHEMA_DIR)
  : resolve(import.meta.dir, "../../engine-compatibility-tests/schema/device");
const OUT_FILE = process.env.HYPEN_DEVICE_GENERATED_OUT
  ? resolve(process.env.HYPEN_DEVICE_GENERATED_OUT)
  : resolve(import.meta.dir, "../packages/core/src/remote/device/generated.ts");

type Json = any;

// --------------------------------------------------------------------------
// Load schema documents
// --------------------------------------------------------------------------

const files = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".schema.json"))
  .sort();
if (files.length === 0) throw new Error(`no schemas in ${SCHEMA_DIR}`);

interface Doc {
  file: string;
  /** "envelope" | "handshake" | capability name like "gallery.pick" */
  key: string;
  version: number;
  json: Json;
}

const docs: Doc[] = files.map((file) => {
  const json = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf-8"));
  const m = file.match(/^(.*)-v(\d+)\.schema\.json$/);
  if (!m) throw new Error(`unexpected schema file name: ${file}`);
  return { file, key: m[1], version: Number(m[2]), json };
});

// --------------------------------------------------------------------------
// Registry (mode / data plane / lifetimes per revision) for the typed map.
// --------------------------------------------------------------------------

interface RegistryRevision {
  version: number;
  mode: "unary" | "stream";
  data: "none" | "jsonEvents" | "binaryUpload" | "binaryDownload";
  lifetimes: string[];
}

const REGISTRY_FILE = join(SCHEMA_DIR, "registry-v1.json");
const registry: Map<string, RegistryRevision[]> = (() => {
  let json: Json;
  try {
    json = JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
  } catch (err) {
    throw new Error(`cannot read ${REGISTRY_FILE}: ${(err as Error).message}`);
  }
  if (!json || !Array.isArray(json.capabilities)) fail("registry-v1.json", "capabilities must be an array");
  const out = new Map<string, RegistryRevision[]>();
  for (const cap of json.capabilities) {
    const where = `registry-v1.json#${String(cap?.name)}`;
    if (typeof cap?.name !== "string" || !Array.isArray(cap.revisions)) fail(where, "malformed capability entry");
    if (out.has(cap.name)) fail(where, "duplicate capability name");
    const revisions: RegistryRevision[] = cap.revisions.map((r: Json) => {
      if (
        !Number.isInteger(r?.version) ||
        !["unary", "stream"].includes(r.mode) ||
        !["none", "jsonEvents", "binaryUpload", "binaryDownload"].includes(r.data) ||
        !Array.isArray(r.lifetimes) ||
        r.lifetimes.length === 0 ||
        r.lifetimes.some((l: unknown) => !["activation", "background", "connection"].includes(l as string))
      ) {
        fail(where, `malformed revision ${JSON.stringify(r).slice(0, 120)}`);
      }
      return { version: r.version, mode: r.mode, data: r.data, lifetimes: [...r.lifetimes] };
    });
    out.set(cap.name, revisions);
  }
  return out;
})();

// --------------------------------------------------------------------------
// Keyword audit — the runtime validator interprets exactly this subset. Any
// other keyword (or type) fails generation instead of being ignored, so a
// schema can never be silently more permissive in TS than it says.
// --------------------------------------------------------------------------

const SUPPORTED_KEYWORDS = new Set([
  "$id", "$schema", "$defs", "$ref", "$comment", "title", "description",
  "type", "const", "enum", "oneOf", "anyOf", "not",
  "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
]);
const SUPPORTED_TYPES = new Set(["object", "array", "string", "integer", "boolean"]);
const NUMERIC_KEYWORDS = [
  "minItems", "maxItems", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
];

function auditSchema(node: Json, where: string): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    fail(where, "schema node must be an object");
  }
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) fail(where, `keyword "${key}"`);
  }
  if (node.type !== undefined && (typeof node.type !== "string" || !SUPPORTED_TYPES.has(node.type))) {
    fail(where, `type ${JSON.stringify(node.type)}`);
  }
  for (const key of NUMERIC_KEYWORDS) {
    if (node[key] !== undefined && typeof node[key] !== "number") {
      fail(where, `${key} must be a number`);
    }
  }
  if (node.uniqueItems !== undefined && typeof node.uniqueItems !== "boolean") {
    fail(where, "uniqueItems must be a boolean");
  }
  if (node.pattern !== undefined) {
    try {
      new RegExp(node.pattern, "u");
    } catch {
      fail(where, `pattern ${JSON.stringify(node.pattern)} is not a valid u-mode RegExp`);
    }
  }
  if (node.required !== undefined && !Array.isArray(node.required)) {
    fail(where, "required must be an array");
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) fail(where, "enum must be an array");
  if (node.type === "array" && node.items === undefined) fail(where, "array without items");
  for (const [k, sub] of Object.entries<Json>(node.$defs ?? {})) auditSchema(sub, `${where}/$defs/${k}`);
  for (const [k, sub] of Object.entries<Json>(node.properties ?? {})) {
    auditSchema(sub, `${where}/properties/${k}`);
  }
  if (node.items !== undefined) auditSchema(node.items, `${where}/items`);
  for (const key of ["oneOf", "anyOf"] as const) {
    if (node[key] === undefined) continue;
    if (!Array.isArray(node[key]) || node[key].length === 0) fail(where, `${key} must be a non-empty array`);
    node[key].forEach((sub: Json, i: number) => auditSchema(sub, `${where}/${key}/${i}`));
  }
  if (node.not !== undefined) auditSchema(node.not, `${where}/not`);
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    auditSchema(node.additionalProperties, `${where}/additionalProperties`);
  }
}

for (const doc of docs) auditSchema(doc.json, doc.file);

// --------------------------------------------------------------------------
// Type emission
// --------------------------------------------------------------------------

/** "gallery.pick" + "params" (+v1) → "GalleryPickV1Params" */
function typeName(docKey: string, version: number, def: string): string {
  const pascal = (s: string) =>
    s
      .split(/[.\-_]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
  if (docKey === "envelope" || docKey === "handshake") return pascal(def);
  return `${pascal(docKey)}V${version}${pascal(def)}`;
}

function fail(where: string, msg: string): never {
  throw new Error(`${where}: unsupported schema construct — ${msg}`);
}

/**
 * Closed integer ranges with at most this many values are emitted as a
 * literal union (`channels: 1 | 2`, `channel: 0`) so an out-of-range literal
 * is a compile error, not only a runtime invalidParams. Wider ranges stay
 * `number` (a 16-value union for `maxCount` would only get in the way of
 * callers passing a computed count; the runtime validator still bounds it).
 */
const SMALL_INTEGER_RANGE = 8;

/** An integer node's TS type: a literal union for small closed ranges. */
function integerType(node: Json): string {
  // Tightest integer bounds from inclusive and exclusive keywords.
  const lows: number[] = [];
  const highs: number[] = [];
  if (node.minimum !== undefined) lows.push(Math.ceil(node.minimum));
  if (node.exclusiveMinimum !== undefined) lows.push(Math.floor(node.exclusiveMinimum) + 1);
  if (node.maximum !== undefined) highs.push(Math.floor(node.maximum));
  if (node.exclusiveMaximum !== undefined) highs.push(Math.ceil(node.exclusiveMaximum) - 1);
  if (lows.length === 0 || highs.length === 0) return "number";
  const lower = Math.max(...lows);
  const upper = Math.min(...highs);
  if (upper < lower) return "never";
  if (upper - lower + 1 > SMALL_INTEGER_RANGE) return "number";
  const values: string[] = [];
  for (let v = lower; v <= upper; v++) values.push(String(v));
  return values.join(" | ");
}

/** Render a schema node as a TS type expression. */
function tsType(node: Json, doc: Doc, where: string): string {
  if (node.$ref) {
    const m = String(node.$ref).match(/^#\/\$defs\/(\w+)$/);
    if (!m) fail(where, `non-local $ref ${node.$ref}`);
    return typeName(doc.key, doc.version, m[1]);
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v: Json) => JSON.stringify(v)).join(" | ");
  // An object with properties AND a oneOf carries a constraint-only guard
  // (e.g. the result/error XOR): the TS shape comes from the properties; the
  // guard is enforced by the runtime validator, not the type system.
  if (node.type === "object" && node.properties && (node.oneOf || node.anyOf)) {
    return tsType({ ...node, oneOf: undefined, anyOf: undefined }, doc, where);
  }
  if (node.oneOf || node.anyOf) {
    const key = node.oneOf ? "oneOf" : "anyOf";
    return node[key]
      .map((sub: Json, i: number) => tsType(sub, doc, `${where}.${key}[${i}]`))
      .join(" | ");
  }
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
      return integerType(node);
    case "boolean":
      return "boolean";
    case "array":
      return `Array<${tsType(node.items, doc, `${where}.items`)}>`;
    case "object": {
      if (!node.properties) return "Record<string, unknown>";
      const required: string[] = node.required ?? [];
      const entries = Object.entries(node.properties);
      if (entries.length === 0) return "Record<string, never>";
      const fields = entries.map(([prop, sub]) => {
        const opt = required.includes(prop) ? "" : "?";
        return `${prop}${opt}: ${tsType(sub, doc, `${where}.${prop}`)}`;
      });
      return `{ ${fields.join("; ")} }`;
    }
    default:
      fail(where, JSON.stringify(node).slice(0, 120));
  }
}

function emitTypes(): string {
  const out: string[] = [];
  for (const doc of docs) {
    out.push(`// ---- ${doc.file} ----`);
    const defs = doc.json.$defs ?? {};
    for (const [def, node] of Object.entries<Json>(defs)) {
      const name = typeName(doc.key, doc.version, def);
      const rendered = tsType(node, doc, `${doc.file}#${def}`);
      // Interfaces only for plain closed objects with fields; unions,
      // aliases and empty objects become type aliases. Decide from the
      // schema node, never from the rendered string.
      const isPlainObject =
        node.type === "object" &&
        node.properties &&
        Object.keys(node.properties).length > 0 &&
        !node.$ref && !node.const && !node.enum &&
        !((node.oneOf || node.anyOf) && node.type !== "object");
      if (isPlainObject) {
        out.push(
          `export interface ${name} ${rendered
            .replace(/^\{ /, "{\n  ")
            .replace(/ \}$/, ";\n}")
            .split("; ").join(";\n  ")}`
        );
      } else {
        out.push(`export type ${name} = ${rendered};`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

// --------------------------------------------------------------------------
// Emit
// --------------------------------------------------------------------------

const capabilityDocs = docs.filter(
  (d) => d.key !== "envelope" && d.key !== "handshake"
);

/** One row per capability name with every shipped revision, ascending. */
const capabilityRows: Array<{ name: string; versions: number[] }> = (() => {
  const byName = new Map<string, number[]>();
  for (const d of capabilityDocs) {
    const versions = byName.get(d.key) ?? [];
    if (versions.includes(d.version)) fail(d.file, `duplicate revision ${d.version}`);
    versions.push(d.version);
    byName.set(d.key, versions);
  }
  return [...byName.keys()]
    .sort()
    .map((name) => ({ name, versions: byName.get(name)!.sort((a, b) => a - b) }));
})();

const header = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Generated by hypen-web/scripts/generate-device-types.ts from the JSON
 * Schemas exported out of hypen-engine-rs (RFC 001, Device Capability
 * Protocol). Regenerate with:
 *
 *   bun scripts/generate-device-types.ts
 *
 * CI fails when this file differs from regeneration (device-generated.test.ts).
 * Provisional until the RFC 001 §6 Phase 4 real-driver gate.
 */

/* eslint-disable */
`;

/**
 * The closed permission enum (RFC 001 P1), named once: `DevicePermission`
 * is the union type and `DEVICE_PERMISSIONS` the same values at runtime,
 * both read from permission.query's params schema.
 */
function permissionAliases(): string {
  const doc = docs.find((d) => d.key === "permission.query");
  const values = doc?.json?.$defs?.params?.properties?.permission?.enum;
  const status = doc?.json?.$defs?.result?.properties?.status?.enum;
  if (!doc || !Array.isArray(values) || !Array.isArray(status)) return "";
  const q = typeName(doc.key, doc.version, "params");
  const r = typeName(doc.key, doc.version, "result");
  return `
/** Every permission a host maps (closed enum; anything else is invalidParams). */
export type DevicePermission = ${q}["permission"];
/** \`permission.query\` / \`permission.request\` outcome. */
export type DevicePermissionStatus = ${r}["status"];
export const DEVICE_PERMISSIONS: ReadonlyArray<DevicePermission> = ${JSON.stringify(values)};
`;
}

/**
 * `DeviceCapabilityMap`: one entry per capability name, keyed on its LATEST
 * revision that has both a schema and a registry entry (the typed server API
 * issues that revision). Carries the payload types and the registry's mode,
 * data plane and lifetimes so the SDK can derive which API consumes it.
 */
function capabilityMap(): string {
  const rows: string[] = [];
  for (const { name, versions } of capabilityRows) {
    const regRevs = registry.get(name) ?? [];
    const version = [...versions].reverse().find((v) => regRevs.some((r) => r.version === v));
    if (version === undefined) continue;
    const rev = regRevs.find((r) => r.version === version)!;
    const doc = capabilityDocs.find((d) => d.key === name && d.version === version)!;
    const defs = doc.json.$defs ?? {};
    const ref = (def: string) =>
      Object.prototype.hasOwnProperty.call(defs, def) ? typeName(name, version, def) : "never";
    rows.push(
      [
        `  ${JSON.stringify(name)}: {`,
        `    version: ${version};`,
        `    mode: ${JSON.stringify(rev.mode)};`,
        `    data: ${JSON.stringify(rev.data)};`,
        `    lifetimes: ${rev.lifetimes.map((l) => JSON.stringify(l)).join(" | ")};`,
        `    params: ${ref("params")};`,
        `    result: ${ref("result")};`,
        `    event: ${ref("event")};`,
        `  };`,
      ].join("\n")
    );
  }
  return `
/**
 * Typed capability map (RFC 001 §4): capability name → its latest revision's
 * params/result/event types and registry mode, data plane and lifetimes.
 * \`context.device.request/stream\` are keyed on it, so an unknown name or
 * ill-typed params is a compile error.
 */
export interface DeviceCapabilityMap {
${rows.join("\n")}
}

export type DeviceCapabilityName = keyof DeviceCapabilityMap;
`;
}

const unions = `
// ---- protocol unions and aliases ----

export type DeviceMessage = DeviceRequest | DeviceResponse | DeviceEvent;
export type DeviceErrorCode = Error_["code"];
export type DeviceLifetime = DeviceRequest["lifetime"];
export const DEVICE_PROTOCOL_VERSION = 1;
${permissionAliases()}${capabilityMap()}`;

// `error` def name collides with the global Error type; rename just that one.
function emitTypesRenamed(): string {
  return emitTypes().replace(/\bError\b(?![a-zA-Z])/g, "Error_");
}

const schemasLiteral = JSON.stringify(
  Object.fromEntries(docs.map((d) => [`${d.key}-v${d.version}`, d.json])),
  null,
  0
);

const validator = `
// ---- schema-interpreting validators (dependency-free) ----

/** The exact exported schema documents, embedded verbatim. */
export const DEVICE_SCHEMAS: Record<string, unknown> = ${schemasLiteral} as const;

export interface SchemaViolation {
  path: string;
  message: string;
}

function violation(path: string, message: string): SchemaViolation {
  return { path, message };
}

/** Own-property test: never consults the prototype chain ("constructor", "__proto__" …). */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural JSON equality (key order insensitive). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/**
 * Canonical JSON text (object keys sorted): two values are JSON-equal iff
 * their canonical texts are equal. Linear in the value's size, so
 * \`uniqueItems\` is one pass with a Set instead of pairwise comparison.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

/** String length in Unicode code points (JSON Schema semantics), not UTF-16 units. */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

const patternCache = new Map<string, RegExp>();
function compiledPattern(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "u");
    patternCache.set(pattern, re);
  }
  return re;
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

/**
 * Interpret the exported schema subset: closed objects, oneOf, anyOf, local
 * $refs, const, enum, bounded integers/strings/arrays (min/max, exclusive
 * bounds, uniqueItems), pattern, object-valued additionalProperties, and
 * required/not guards. EVERY keyword on a node is evaluated — a \`$ref\`,
 * \`const\`, \`enum\`, \`oneOf\`, \`anyOf\` or \`not\` never hides its siblings —
 * and the generator refuses any other keyword, so nothing here is silently
 * permissive. Cost is linear in the value: an array over \`maxItems\` is
 * rejected before any per-item work, and \`uniqueItems\` uses one Set pass.
 */
function check(
  node: any,
  value: unknown,
  root: any,
  path: string,
  out: SchemaViolation[]
): void {
  if (node === true) return;
  if (node === false) {
    out.push(violation(path, "forbidden by schema"));
    return;
  }
  if (node === undefined || node === null || typeof node !== "object") {
    out.push(violation(path, "schema node missing"));
    return;
  }
  // A type mismatch makes every type-specific keyword moot; stop here so
  // one wrong type yields one violation.
  if (hasOwn(node, "type") && !typeMatches(node.type, value)) {
    out.push(violation(path, \`expected \${String(node.type)}\`));
    return;
  }
  if (hasOwn(node, "$ref")) {
    const name = /^#\\/\\$defs\\/(\\w+)$/.exec(String(node.$ref))?.[1];
    const defs = root?.$defs;
    const target = name !== undefined && defs && hasOwn(defs, name) ? defs[name] : undefined;
    if (!target) out.push(violation(path, \`unresolvable $ref \${node.$ref}\`));
    else check(target, value, root, path, out);
  }
  if (hasOwn(node, "const") && !jsonEqual(value, node.const)) {
    out.push(violation(path, \`expected const \${JSON.stringify(node.const)}\`));
  }
  if (hasOwn(node, "enum") && !node.enum.some((v: unknown) => jsonEqual(v, value))) {
    out.push(violation(path, \`not one of \${JSON.stringify(node.enum)}\`));
  }
  if (hasOwn(node, "oneOf")) {
    let matches = 0;
    let firstErrors: SchemaViolation[] | null = null;
    for (const sub of node.oneOf) {
      const errs: SchemaViolation[] = [];
      check(sub, value, root, path, errs);
      if (errs.length === 0) matches += 1;
      else if (!firstErrors) firstErrors = errs;
    }
    if (matches === 0) {
      out.push(violation(path, "matched no oneOf branch"));
      if (firstErrors) out.push(...firstErrors.slice(0, 3));
    } else if (matches > 1) {
      out.push(violation(path, \`matched \${matches} oneOf branches (must be exactly 1)\`));
    }
  }
  if (hasOwn(node, "anyOf")) {
    let firstErrors: SchemaViolation[] | null = null;
    let matched = false;
    for (const sub of node.anyOf) {
      const errs: SchemaViolation[] = [];
      check(sub, value, root, path, errs);
      if (errs.length === 0) {
        matched = true;
        break;
      }
      if (!firstErrors) firstErrors = errs;
    }
    if (!matched) {
      out.push(violation(path, "matched no anyOf branch"));
      if (firstErrors) out.push(...firstErrors.slice(0, 3));
    }
  }
  if (hasOwn(node, "not")) {
    const errs: SchemaViolation[] = [];
    check(node.not, value, root, path, errs);
    if (errs.length === 0) out.push(violation(path, "matched forbidden schema (not)"));
  }
  // Type-specific keywords apply to values of that type (JSON Schema
  // semantics); the \`type\` keyword above already enforced the type itself.
  if (isPlainObject(value)) checkObjectKeywords(node, value, root, path, out);
  else if (Array.isArray(value)) checkArrayKeywords(node, value, root, path, out);
  else if (typeof value === "string") checkStringKeywords(node, value, path, out);
  else if (typeof value === "number") checkNumberKeywords(node, value, path, out);
}

/** properties / required / additionalProperties. */
function checkObjectKeywords(
  node: any,
  value: Record<string, unknown>,
  root: any,
  path: string,
  out: SchemaViolation[]
): void {
  if (node.required !== undefined) {
    for (const key of node.required)
      if (!hasOwn(value, key)) out.push(violation(path, \`missing required \${key}\`));
  }
  if (node.properties === undefined && node.additionalProperties === undefined) return;
  const props: Record<string, unknown> = node.properties ?? {};
  for (const key of Object.keys(value)) {
    if (hasOwn(props, key)) {
      check(props[key], value[key], root, \`\${path}.\${key}\`, out);
    } else if (node.additionalProperties === false) {
      out.push(violation(path, \`unexpected property \${key}\`));
    } else if (isPlainObject(node.additionalProperties)) {
      check(node.additionalProperties, value[key], root, \`\${path}.\${key}\`, out);
    }
  }
}

/** maxItems (checked first: nothing else runs on an oversize array) / minItems / uniqueItems / items. */
function checkArrayKeywords(
  node: any,
  value: unknown[],
  root: any,
  path: string,
  out: SchemaViolation[]
): void {
  if (node.maxItems !== undefined && value.length > node.maxItems) {
    out.push(violation(path, \`more than \${node.maxItems} items\`));
    return;
  }
  if (node.minItems !== undefined && value.length < node.minItems)
    out.push(violation(path, \`fewer than \${node.minItems} items\`));
  if (node.uniqueItems === true) {
    const seen = new Map<string, number>();
    for (let i = 0; i < value.length; i++) {
      const key = canonicalJson(value[i]);
      const first = seen.get(key);
      if (first !== undefined) {
        out.push(violation(path, \`duplicate items at \${first} and \${i}\`));
        break;
      }
      seen.set(key, i);
    }
  }
  if (node.items !== undefined) {
    for (let i = 0; i < value.length; i++) check(node.items, value[i], root, \`\${path}[\${i}]\`, out);
  }
}

/** minLength / maxLength (code points) / pattern. */
function checkStringKeywords(node: any, value: string, path: string, out: SchemaViolation[]): void {
  if (node.maxLength !== undefined || node.minLength !== undefined) {
    const len = codePointLength(value);
    if (node.maxLength !== undefined && len > node.maxLength)
      out.push(violation(path, \`longer than \${node.maxLength}\`));
    if (node.minLength !== undefined && len < node.minLength)
      out.push(violation(path, \`shorter than \${node.minLength}\`));
  }
  if (node.pattern !== undefined && !compiledPattern(node.pattern).test(value))
    out.push(violation(path, \`does not match \${node.pattern}\`));
}

/** minimum / maximum / exclusiveMinimum / exclusiveMaximum. */
function checkNumberKeywords(node: any, value: number, path: string, out: SchemaViolation[]): void {
  if (node.minimum !== undefined && value < node.minimum)
    out.push(violation(path, \`below minimum \${node.minimum}\`));
  if (node.maximum !== undefined && value > node.maximum)
    out.push(violation(path, \`above maximum \${node.maximum}\`));
  if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum)
    out.push(violation(path, \`not above \${node.exclusiveMinimum}\`));
  if (node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum)
    out.push(violation(path, \`not below \${node.exclusiveMaximum}\`));
}

function validate(docKey: string, def: string | null, value: unknown): SchemaViolation[] {
  const doc: any = hasOwn(DEVICE_SCHEMAS, docKey) ? DEVICE_SCHEMAS[docKey] : undefined;
  const out: SchemaViolation[] = [];
  if (!doc) return [violation("$", \`unknown schema document \${docKey}\`)];
  const node = def === null ? doc : doc.$defs && hasOwn(doc.$defs, def) ? doc.$defs[def] : undefined;
  if (!node) return [violation("$", \`unknown definition \${def} in \${docKey}\`)];
  check(node, value, doc, "$", out);
  return out;
}

/** Validate a full device envelope message against envelope-v1. */
export function validateDeviceMessage(value: unknown): SchemaViolation[] {
  const t = isPlainObject(value) && hasOwn(value, "type") ? value.type : undefined;
  const def =
    t === "deviceRequest" ? "deviceRequest"
    : t === "deviceResponse" ? "deviceResponse"
    : t === "deviceEvent" ? "deviceEvent"
    : null;
  if (def === null) return [violation("$", \`unknown device message type \${String(t)}\`)];
  return validate("envelope-v1", def, value);
}

/** \`sessionAck.device\` (the client's side of the handshake). */
export function validateDeviceAck(value: unknown): SchemaViolation[] {
  return validate("handshake-v1", "deviceAck", value);
}

function capabilityDef(
  capability: string,
  version: number,
  def: "params" | "result" | "event"
): string | null {
  const key = \`\${capability}-v\${version}\`;
  const doc: any = hasOwn(DEVICE_SCHEMAS, key) ? DEVICE_SCHEMAS[key] : undefined;
  if (!doc || !doc.$defs || !hasOwn(doc.$defs, def)) return null;
  return key;
}

/** Validate capability params/result/event against the selected revision. */
export function validateCapabilityPayload(
  capability: string,
  version: number,
  def: "params" | "result" | "event",
  value: unknown
): SchemaViolation[] {
  const key = capabilityDef(capability, version, def);
  if (!key)
    return [violation("$", \`no \${def} schema for \${capability}@\${version}\`)];
  return validate(key, def, value);
}
`;

const output =
  header + "\n" + emitTypesRenamed() + unions + validator + "\n";

const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  let existing = "";
  try {
    existing = readFileSync(OUT_FILE, "utf-8");
  } catch {
    console.error(`missing ${OUT_FILE} — run without --check to generate`);
    process.exit(1);
  }
  if (existing !== output) {
    console.error("generated.ts is stale — run: bun scripts/generate-device-types.ts");
    process.exit(1);
  }
  console.log("generated.ts is up to date");
} else {
  writeFileSync(OUT_FILE, output);
  console.log(`wrote ${OUT_FILE} (${output.length} bytes, ${docs.length} schema docs)`);
}
