/**
 * Pure utility functions for the Hypen parser.
 *
 * This module is intentionally free of vscode-languageserver dependencies
 * so it can be tested without VS Code extension infrastructure.
 */

// Minimal position/range types compatible with vscode-languageserver
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface ParseError {
  range: Range;
  message: string;
  severity: "error" | "warning";
}

export type ValueNode =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "reference"; value: string }
  | { type: "list"; value: ValueNode[] }
  | { type: "map"; value: Map<string, ValueNode> }
  | { type: "identifier"; value: string };

// WASM value type (matching Rust struct definitions)
export interface WasmValue {
  String?: string;
  Number?: number;
  Boolean?: boolean;
  Reference?: string;
  List?: WasmValue[];
  Map?: Record<string, WasmValue>;
}

/**
 * Convert a WASM value to our ValueNode type
 */
export function convertWasmValue(val: WasmValue | undefined): ValueNode {
  if (!val) return { type: "string", value: "" };
  if (val.String !== undefined) return { type: "string", value: val.String };
  if (val.Number !== undefined) return { type: "number", value: val.Number };
  if (val.Boolean !== undefined) return { type: "boolean", value: val.Boolean };
  if (val.Reference !== undefined) return { type: "reference", value: val.Reference };
  if (val.List !== undefined) return { type: "list", value: val.List.map(v => convertWasmValue(v)) };
  if (val.Map !== undefined) {
    const map = new Map<string, ValueNode>();
    for (const [key, entry] of Object.entries(val.Map)) {
      map.set(key, convertWasmValue(entry));
    }
    return { type: "map", value: map };
  }
  return { type: "string", value: "" };
}

/**
 * Convert byte offset to line and character position
 */
export function offsetToPosition(text: string, offset: number): Position {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

/**
 * Check if a position is inside a string literal (handles both quote types)
 */
export function isInString(text: string, line: number, character: number): boolean {
  const lines = text.split("\n");
  if (line >= lines.length) {
    return false;
  }

  const currentLine = lines[line];
  let inString = false;
  let stringChar = "";
  let escaped = false;

  for (let i = 0; i <= character && i < currentLine.length; i++) {
    const char = currentLine[i];
    if (char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !escaped) {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }
    escaped = false;
  }

  return inString;
}

export interface DiagnosticsResult {
  errors: ParseError[];
  warnings: ParseError[];
}

/**
 * Scan text for unclosed strings, braces, parentheses, and brackets.
 */
export function scanDiagnostics(text: string): DiagnosticsResult {
  const errors: ParseError[] = [];
  const warnings: ParseError[] = [];
  const lines = text.split("\n");
  let braceBalance = 0;
  let parenBalance = 0;
  let bracketBalance = 0;
  const braceStack: Position[] = [];
  const parenStack: Position[] = [];
  const bracketStack: Position[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("//")) continue;

    // Unclosed strings
    let inString = false;
    let stringChar = "";
    let stringStart = 0;
    let escaped = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === "\\" && !escaped) { escaped = true; continue; }
      if ((char === '"' || char === "'") && !escaped) {
        if (!inString) { inString = true; stringChar = char; stringStart = j; }
        else if (char === stringChar) { inString = false; }
      }
      escaped = false;
    }

    if (inString) {
      errors.push({
        range: { start: { line: i, character: stringStart }, end: { line: i, character: line.length } },
        message: "Unclosed string literal",
        severity: "error"
      });
    }

    // Bracket tracking — skip characters inside strings and after inline comments
    let scanInString: string | null = null;
    let scanEscaped = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];

      // Handle escape sequences inside strings
      if (scanEscaped) { scanEscaped = false; continue; }
      if (char === "\\" && scanInString !== null) { scanEscaped = true; continue; }

      // Toggle string state
      if ((char === '"' || char === "'") && scanInString === null) {
        scanInString = char;
        continue;
      }
      if (scanInString !== null) {
        if (char === scanInString) { scanInString = null; }
        continue;
      }

      // Detect inline comments — ignore rest of line
      if (char === "/" && j + 1 < line.length && line[j + 1] === "/") {
        break;
      }

      if (char === "{") { braceBalance++; braceStack.push({ line: i, character: j }); }
      else if (char === "}") {
        braceBalance--;
        if (braceBalance < 0) {
          errors.push({ range: { start: { line: i, character: j }, end: { line: i, character: j + 1 } }, message: "Unexpected closing brace '}'", severity: "error" });
          braceBalance = 0;
        } else { braceStack.pop(); }
      } else if (char === "(") { parenBalance++; parenStack.push({ line: i, character: j }); }
      else if (char === ")") {
        parenBalance--;
        if (parenBalance < 0) {
          errors.push({ range: { start: { line: i, character: j }, end: { line: i, character: j + 1 } }, message: "Unexpected closing parenthesis ')'", severity: "error" });
          parenBalance = 0;
        } else { parenStack.pop(); }
      } else if (char === "[") { bracketBalance++; bracketStack.push({ line: i, character: j }); }
      else if (char === "]") {
        bracketBalance--;
        if (bracketBalance < 0) {
          errors.push({ range: { start: { line: i, character: j }, end: { line: i, character: j + 1 } }, message: "Unexpected closing bracket ']'", severity: "error" });
          bracketBalance = 0;
        } else { bracketStack.pop(); }
      }
    }
  }

  if (braceBalance > 0) {
    const lastBrace = braceStack[braceStack.length - 1] || { line: 0, character: 0 };
    errors.push({ range: { start: lastBrace, end: { line: lastBrace.line, character: lastBrace.character + 1 } }, message: `Unclosed braces: ${braceBalance} closing brace(s) expected`, severity: "error" });
  }

  if (parenBalance > 0) {
    const lastParen = parenStack[parenStack.length - 1] || { line: lines.length - 1, character: 0 };
    errors.push({ range: { start: lastParen, end: { line: lastParen.line, character: lastParen.character + 1 } }, message: `Unclosed parentheses: ${parenBalance} closing parenthesis expected`, severity: "error" });
  }

  if (bracketBalance > 0) {
    const lastBracket = bracketStack[bracketStack.length - 1] || { line: lines.length - 1, character: 0 };
    errors.push({ range: { start: lastBracket, end: { line: lastBracket.line, character: lastBracket.character + 1 } }, message: `Unclosed brackets: ${bracketBalance} closing bracket(s) expected`, severity: "error" });
  }

  return { errors, warnings };
}
