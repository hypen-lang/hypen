/**
 * Editing a JSON file as text: set or remove one value and leave every
 * other byte — key order, indentation, blank lines — as the user wrote it.
 * `JSON.parse` + `JSON.stringify` would reformat the whole file, which
 * turns a one-entry change into an unreviewable diff.
 *
 * Plain JSON only (what `hypen.json` is: the loader is `JSON.parse`).
 */

type JsonNode =
  | { kind: "object"; start: number; end: number; members: JsonMember[] }
  | { kind: "other"; start: number; end: number };

interface JsonMember {
  key: string;
  /** Offset of the key's opening quote. */
  start: number;
  value: JsonNode;
}

export class JsonEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonEditError";
  }
}

function parse(text: string): JsonNode {
  let pos = 0;
  const fail = (what: string): never => {
    throw new JsonEditError(`${what} at offset ${pos}`);
  };
  const ws = (): void => {
    while (pos < text.length && /\s/.test(text[pos] as string)) pos++;
  };
  const string = (): string => {
    const start = pos;
    if (text[pos] !== '"') fail("expected a string");
    pos++;
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === "\\" ? 2 : 1;
    if (pos >= text.length) fail("unterminated string");
    pos++;
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const value = (): JsonNode => {
    ws();
    const start = pos;
    const ch = text[pos];
    if (ch === "{") {
      pos++;
      const members: JsonMember[] = [];
      ws();
      if (text[pos] === "}") {
        pos++;
        return { kind: "object", start, end: pos, members };
      }
      for (;;) {
        ws();
        const keyStart = pos;
        const key = string();
        ws();
        if (text[pos] !== ":") fail('expected ":"');
        pos++;
        members.push({ key, start: keyStart, value: value() });
        ws();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return { kind: "object", start, end: pos, members };
        }
        fail('expected "," or "}"');
      }
    }
    if (ch === "[") {
      pos++;
      ws();
      if (text[pos] === "]") {
        pos++;
        return { kind: "other", start, end: pos };
      }
      for (;;) {
        value();
        ws();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return { kind: "other", start, end: pos };
        }
        fail('expected "," or "]"');
      }
    }
    if (ch === '"') {
      string();
      return { kind: "other", start, end: pos };
    }
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (literal === null) fail("unexpected token");
    pos += (literal as RegExpExecArray)[0].length;
    return { kind: "other", start, end: pos };
  };
  const root = value();
  ws();
  if (pos !== text.length) fail("unexpected trailing content");
  return root;
}

/** The whitespace a line starts with. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
}

/** The file's indentation unit: what its first indented line starts with. */
function indentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Serialise `value` the way a hand-written hypen.json looks: objects one
 * member per line, lists of scalars on one line.
 */
export function formatJsonValue(value: unknown, indent: string, unit: string): string {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) {
      return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    }
    const inner = indent + unit;
    return `[\n${value.map((v) => inner + formatJsonValue(v, inner, unit)).join(",\n")}\n${indent}]`;
  }
  if (isPlain(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    const inner = indent + unit;
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJsonValue(v, inner, unit)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function find(root: JsonNode, path: readonly string[]): { node: JsonNode; depth: number; member?: JsonMember; parent?: JsonNode } {
  let node = root;
  let member: JsonMember | undefined;
  let parent: JsonNode | undefined;
  let depth = 0;
  for (const key of path) {
    if (node.kind !== "object") break;
    const next = node.members.find((m) => m.key === key);
    if (next === undefined) break;
    parent = node;
    member = next;
    node = next.value;
    depth++;
  }
  return { node, depth, member, parent };
}

/**
 * Set the value at `path` (object keys from the root), creating missing
 * objects on the way. Everything outside the changed value keeps its text.
 *
 * @throws {JsonEditError} when `text` is not JSON, or the path runs through
 *   something that is not an object.
 */
export function setJsonPath(text: string, path: readonly string[], value: unknown): string {
  const root = parse(text);
  const unit = indentUnit(text);
  const { node, depth } = find(root, path);
  if (depth === path.length) {
    return text.slice(0, node.start) + formatJsonValue(value, lineIndent(text, node.start), unit) + text.slice(node.end);
  }
  if (node.kind !== "object") {
    throw new JsonEditError(`"${path.slice(0, depth).join(".")}" is not an object`);
  }
  // Wrap the value in the objects that are missing below `node`.
  let nested = value;
  for (let i = path.length - 1; i > depth; i--) nested = { [path[i] as string]: nested };
  const key = path[depth] as string;
  const last = node.members[node.members.length - 1];
  if (last !== undefined) {
    const indent = lineIndent(text, last.start);
    const insert = `,\n${indent}${JSON.stringify(key)}: ${formatJsonValue(nested, indent, unit)}`;
    return text.slice(0, last.value.end) + insert + text.slice(last.value.end);
  }
  const outer = lineIndent(text, node.start);
  const indent = outer + unit;
  const object = `{\n${indent}${JSON.stringify(key)}: ${formatJsonValue(nested, indent, unit)}\n${outer}}`;
  return text.slice(0, node.start) + object + text.slice(node.end);
}

/**
 * Remove the member at `path`. With `prune`, objects left empty by the
 * removal are removed too, up to (not including) `prune` levels from the
 * root — `removeJsonPath(text, ["wasm", "packages", "x"], 1)` drops an empty
 * `packages` but keeps `wasm`'s other keys. Returns `text` unchanged when
 * the path does not exist.
 */
export function removeJsonPath(text: string, path: readonly string[], prune?: number): string {
  const root = parse(text);
  const { depth, member, parent } = find(root, path);
  if (depth !== path.length || member === undefined || parent === undefined || parent.kind !== "object") return text;
  const index = parent.members.indexOf(member);
  let out: string;
  if (parent.members.length === 1) {
    out = text.slice(0, parent.start + 1) + text.slice(parent.end - 1);
  } else if (index < parent.members.length - 1) {
    out = text.slice(0, member.start) + text.slice((parent.members[index + 1] as JsonMember).start);
  } else {
    out = text.slice(0, (parent.members[index - 1] as JsonMember).value.end) + text.slice(member.value.end);
  }
  if (prune !== undefined && parent.members.length === 1 && path.length - 1 > prune) {
    return removeJsonPath(out, path.slice(0, -1), prune);
  }
  return out;
}

/** The parsed value at `path`, or `undefined`. */
export function getJsonPath(text: string, path: readonly string[]): unknown {
  let value: unknown = JSON.parse(text);
  for (const key of path) {
    if (!isPlain(value)) return undefined;
    value = value[key];
  }
  return value;
}
