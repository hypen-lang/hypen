/**
 * Parser module for Hypen language
 *
 * This module provides a TypeScript interface to the Hypen parser.
 * Uses the Rust WASM parser when available, with regex fallback.
 */

import { Range, Position } from "vscode-languageserver/node";
import {
  convertWasmValue,
  offsetToPosition,
  isInString as isInStringUtil,
} from "./parser-utils";
import type { WasmValue } from "./parser-utils";

export interface ParseError {
  range: Range;
  message: string;
  severity: "error" | "warning";
}

export interface ComponentNode {
  name: string;
  range: Range;
  declarationType?: "module" | "component" | "regular";
  arguments?: ArgumentNode[];
  applicators?: ApplicatorNode[];
  children?: ComponentNode[];
}

export interface ArgumentNode {
  name?: string; // undefined for positional args
  value: ValueNode;
  range: Range;
}

export type ValueNode =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "reference"; value: string } // @state.x, @actions.y
  | { type: "list"; value: ValueNode[] }
  | { type: "map"; value: Map<string, ValueNode> }
  | { type: "identifier"; value: string };

export interface ApplicatorNode {
  name: string;
  arguments: ArgumentNode[];
  range: Range;
  /**
   * Components nested in an applicator children block, e.g. the
   * `onState(...)` entries of `.states(@state.x) { onState(a).size(48) }`.
   * Present (possibly empty) when parsed via WASM; the regex fallback
   * parser cannot see applicator blocks and never sets it.
   */
  children?: ComponentNode[];
}

export interface ParseResult {
  errors: ParseError[];
  warnings: ParseError[];
  components: ComponentNode[];
}

// WASM parser types (matching Rust struct definitions)
interface WasmParseError {
  message: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

interface WasmArgument {
  Positioned?: { position: number; value: WasmValue };
  Named?: { key: string; value: WasmValue };
}

interface WasmApplicator {
  name: string;
  arguments: { arguments: WasmArgument[] };
  children: WasmComponent[];
  internal_id: string;
}

interface WasmMetaData {
  internal_id: string;
  name_range: { start: number; end: number };
  block_range?: { start: number; end: number };
}

interface WasmComponent {
  id: string;
  name: string;
  declaration_type: "Component" | "Module" | "ComponentKeyword";
  arguments: { arguments: WasmArgument[] };
  applicators: WasmApplicator[];
  children: WasmComponent[];
  metadata: WasmMetaData;
}

interface WasmDocument {
  imports: unknown[];
  components: WasmComponent[];
}

interface WasmParseResult {
  success: boolean;
  document?: WasmDocument;
  components?: WasmComponent[];
  errors: WasmParseError[];
}

// WASM module interface
interface HypenParserWasm {
  parse_document_wasm(source: string): WasmParseResult;
  parse_components_wasm(source: string): WasmParseResult;
  parse_component_wasm(source: string): WasmParseResult;
  parser_version(): string;
}

// Singleton WASM parser instance
let wasmParser: HypenParserWasm | null = null;
let wasmLoadAttempted = false;

/**
 * Try to load the WASM parser
 */
export async function initWasmParser(): Promise<boolean> {
  if (wasmLoadAttempted) {
    return wasmParser !== null;
  }
  wasmLoadAttempted = true;

  try {
    // Try to load from relative path (pkg/nodejs is symlinked or copied)
    const wasmModule = await import("../wasm/hypen_parser.js");
    wasmParser = wasmModule as HypenParserWasm;
    console.log(`WASM parser loaded: v${wasmParser.parser_version()}`);
    return true;
  } catch (e) {
    console.log("WASM parser not available, using regex fallback:", e);
    return false;
  }
}

/**
 * Check if WASM parser is available
 */
export function isWasmParserAvailable(): boolean {
  return wasmParser !== null;
}

/**
 * Convert WASM component to our ComponentNode type
 */
function convertWasmComponent(text: string, comp: WasmComponent): ComponentNode {
  const startPos = offsetToPosition(text, comp.metadata.name_range.start);
  const endPos = offsetToPosition(text, comp.metadata.name_range.end);

  const node: ComponentNode = {
    name: comp.name,
    range: { start: startPos, end: endPos },
    declarationType: comp.declaration_type === "Module" ? "module"
                   : comp.declaration_type === "ComponentKeyword" ? "component"
                   : "regular",
    children: comp.children.map(c => convertWasmComponent(text, c)),
  };

  if (comp.applicators.length > 0) {
    // Use block_range for applicator ranges when available, otherwise fall back
    const blockStart = comp.metadata.block_range
      ? offsetToPosition(text, comp.metadata.block_range.start)
      : startPos;
    const blockEnd = comp.metadata.block_range
      ? offsetToPosition(text, comp.metadata.block_range.end)
      : endPos;

    node.applicators = comp.applicators.map(app => {
      const args: ArgumentNode[] = app.arguments.arguments.map(arg => {
        const value = convertWasmValue(arg.Named?.value ?? arg.Positioned?.value);
        return {
          name: arg.Named?.key,
          value,
          range: { start: startPos, end: endPos },
        };
      });
      const applicatorNode: ApplicatorNode = {
        name: app.name,
        arguments: args,
        range: { start: blockStart, end: blockEnd },
      };
      // Applicator children blocks (.states { onState(...) }) carry full
      // component specifications — convert them so document-model consumers
      // (diagnostics, references, future completion) see inside the block.
      // Guard for stale WASM builds predating applicator children.
      if (app.children && app.children.length > 0) {
        applicatorNode.children = app.children.map(c => convertWasmComponent(text, c));
      }
      return applicatorNode;
    });
  }

  return node;
}

/**
 * Parse using WASM parser
 */
function parseWithWasm(text: string): ParseResult | null {
  if (!wasmParser) return null;

  try {
    const result = wasmParser.parse_document_wasm(text);

    const errors: ParseError[] = result.errors.map(e => ({
      range: {
        start: { line: e.line, character: e.column },
        end: offsetToPosition(text, e.end),
      },
      message: e.message,
      severity: "error" as const,
    }));

    const components: ComponentNode[] = [];
    if (result.success && result.document) {
      for (const comp of result.document.components) {
        components.push(convertWasmComponent(text, comp));
      }
    }

    return { errors, warnings: [], components };
  } catch (e) {
    console.error("WASM parse error:", e);
    return null;
  }
}

/**
 * Parse a Hypen document and return the AST with errors
 * Uses WASM parser if available, otherwise falls back to regex-based parsing
 */
export function parseHypenDocument(text: string): ParseResult {
  // Try WASM parser first
  const wasmResult = parseWithWasm(text);
  if (wasmResult) {
    return wasmResult;
  }

  // Fallback to regex-based parsing
  return parseWithRegex(text);
}

/**
 * Parse a single value token string into a ValueNode.
 * Handles strings (double/single quoted), numbers, booleans, and references.
 */
function parseValueToken(token: string): ValueNode {
  const trimmed = token.trim();

  // Double-quoted string
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { type: "string", value: trimmed.slice(1, -1) };
  }

  // Single-quoted string
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return { type: "string", value: trimmed.slice(1, -1) };
  }

  // Boolean
  if (trimmed === "true") return { type: "boolean", value: true };
  if (trimmed === "false") return { type: "boolean", value: false };

  // Reference (@state.x, @actions.y)
  if (trimmed.startsWith("@")) {
    return { type: "reference", value: trimmed };
  }

  // Number
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== "") {
    return { type: "number", value: num };
  }

  // Fall back to identifier
  return { type: "identifier", value: trimmed };
}

/**
 * Split arguments respecting nested delimiters and strings.
 * Returns an array of raw argument strings.
 */
function splitArguments(content: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let escaped = false;
  let current = "";

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && inStr !== null) {
      current += ch;
      escaped = true;
      continue;
    }

    if ((ch === '"' || ch === "'") && inStr === null) {
      inStr = ch;
      current += ch;
      continue;
    }
    if (inStr !== null) {
      current += ch;
      if (ch === inStr) inStr = null;
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      current += ch;
      continue;
    }

    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  const last = current.trim();
  if (last !== "") args.push(last);

  return args;
}

/**
 * Parse applicator arguments from a line like `.padding(16)` or `.color("blue")`.
 * Extracts the content between the first matched parentheses and parses each argument.
 */
function parseApplicatorArguments(line: string, lineIndex: number): ArgumentNode[] {
  // Find the first '(' that belongs to the applicator
  const openIdx = line.indexOf("(");
  if (openIdx < 0) return [];

  // Find matching close paren, respecting nesting and strings
  let depth = 0;
  let closeIdx = -1;
  let inStr: string | null = null;
  let escaped = false;
  for (let j = openIdx; j < line.length; j++) {
    const ch = line[j];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inStr !== null) { escaped = true; continue; }
    if ((ch === '"' || ch === "'") && inStr === null) { inStr = ch; continue; }
    if (inStr !== null) { if (ch === inStr) inStr = null; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { closeIdx = j; break; }
    }
  }

  if (closeIdx < 0) return []; // unclosed — handled by bracket balance checker

  const inner = line.substring(openIdx + 1, closeIdx);
  if (inner.trim() === "") return [];

  const rawArgs = splitArguments(inner);
  const result: ArgumentNode[] = [];

  for (const raw of rawArgs) {
    // Check for named argument: "key: value"
    const namedMatch = raw.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    if (namedMatch) {
      const argName = namedMatch[1];
      const argValue = namedMatch[2].trim();
      result.push({
        name: argName,
        value: parseValueToken(argValue),
        range: {
          start: { line: lineIndex, character: openIdx + 1 },
          end: { line: lineIndex, character: closeIdx },
        },
      });
    } else {
      // Positional argument
      result.push({
        value: parseValueToken(raw),
        range: {
          start: { line: lineIndex, character: openIdx + 1 },
          end: { line: lineIndex, character: closeIdx },
        },
      });
    }
  }

  return result;
}

/**
 * Regex-based parser fallback
 */
function parseWithRegex(text: string): ParseResult {
  const errors: ParseError[] = [];
  const warnings: ParseError[] = [];
  const components: ComponentNode[] = [];
  
  const lines = text.split("\n");
  let braceBalance = 0;
  let parenBalance = 0;
  let bracketBalance = 0;
  const braceStack: { line: number; character: number }[] = [];
  const parenStack: { line: number; character: number }[] = [];
  const bracketStack: { line: number; character: number }[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("//")) {
      continue;
    }
    
    // Check for unclosed strings (double and single quotes)
    let inString = false;
    let stringChar = "";
    let stringStart = 0;
    let escaped = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if ((char === '"' || char === "'") && !escaped) {
        if (!inString) {
          inString = true;
          stringChar = char;
          stringStart = j;
        } else if (char === stringChar) {
          inString = false;
        }
      }
      escaped = false;
    }

    if (inString) {
      errors.push({
        range: {
          start: { line: i, character: stringStart },
          end: { line: i, character: line.length }
        },
        message: "Unclosed string literal",
        severity: "error"
      });
    }
    
    // Track braces — skip characters inside strings and after inline comments
    let scanInStr: string | null = null;
    let scanEsc = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];

      if (scanEsc) { scanEsc = false; continue; }
      if (char === "\\" && scanInStr !== null) { scanEsc = true; continue; }

      if ((char === '"' || char === "'") && scanInStr === null) {
        scanInStr = char;
        continue;
      }
      if (scanInStr !== null) {
        if (char === scanInStr) { scanInStr = null; }
        continue;
      }

      if (char === "/" && j + 1 < line.length && line[j + 1] === "/") {
        break;
      }

      if (char === "{") {
        braceBalance++;
        braceStack.push({ line: i, character: j });
      } else if (char === "}") {
        braceBalance--;
        if (braceBalance < 0) {
          errors.push({
            range: {
              start: { line: i, character: j },
              end: { line: i, character: j + 1 }
            },
            message: "Unexpected closing brace '}'",
            severity: "error"
          });
          braceBalance = 0;
        } else {
          braceStack.pop();
        }
      } else if (char === "(") {
        parenBalance++;
        parenStack.push({ line: i, character: j });
      } else if (char === ")") {
        parenBalance--;
        if (parenBalance < 0) {
          errors.push({
            range: {
              start: { line: i, character: j },
              end: { line: i, character: j + 1 }
            },
            message: "Unexpected closing parenthesis ')'",
            severity: "error"
          });
          parenBalance = 0;
        } else {
          parenStack.pop();
        }
      } else if (char === "[") {
        bracketBalance++;
        bracketStack.push({ line: i, character: j });
      } else if (char === "]") {
        bracketBalance--;
        if (bracketBalance < 0) {
          errors.push({
            range: {
              start: { line: i, character: j },
              end: { line: i, character: j + 1 }
            },
            message: "Unexpected closing bracket ']'",
            severity: "error"
          });
          bracketBalance = 0;
        } else {
          bracketStack.pop();
        }
      }
    }
    
    // Check for module/component declarations
    const moduleMatch = trimmed.match(/^(module|component)\s+([A-Z]\w*)/);
    if (moduleMatch) {
      const keyword = moduleMatch[1];
      const name = moduleMatch[2];
      const startChar = line.indexOf(name);
      if (startChar < 0) continue;

      components.push({
        name,
        declarationType: keyword === "module" ? "module" : "component",
        range: {
          start: { line: i, character: startChar },
          end: { line: i, character: startChar + name.length }
        }
      });
      continue;
    }
    
    // Check for regular component declarations
    const componentMatch = trimmed.match(/^([A-Z]\w*)(\s*\(|\s*\{)?/);
    if (componentMatch) {
      const name = componentMatch[1];
      const startChar = line.indexOf(name);
      if (startChar < 0) continue;

      components.push({
        name,
        declarationType: "regular",
        range: {
          start: { line: i, character: startChar },
          end: { line: i, character: startChar + name.length }
        }
      });
    }
    
    // Check for applicators
    const applicatorMatch = trimmed.match(/^\.(\w+)\s*\(/);
    if (applicatorMatch && components.length > 0) {
      const name = applicatorMatch[1];
      const lastComponent = components[components.length - 1];

      if (!lastComponent.applicators) {
        lastComponent.applicators = [];
      }

      const dotPos = line.indexOf("." + name);
      const applicatorStart = dotPos >= 0 ? dotPos : 0;

      // Parse arguments from the parenthesized content
      const args = parseApplicatorArguments(line, i);

      lastComponent.applicators.push({
        name,
        arguments: args,
        range: {
          start: { line: i, character: applicatorStart },
          end: { line: i, character: applicatorStart + name.length + 1 }
        }
      });
    }
    
    // Check for invalid component names (starting with lowercase)
    const invalidComponentMatch = trimmed.match(/^([a-z]\w*)\s*(\{|\()/);
    if (invalidComponentMatch) {
      const name = invalidComponentMatch[1];
      const startChar = Math.max(0, line.indexOf(name));

      warnings.push({
        range: {
          start: { line: i, character: startChar },
          end: { line: i, character: startChar + name.length }
        },
        message: `Component names should start with an uppercase letter. Did you mean '${name.charAt(0).toUpperCase() + name.slice(1)}'?`,
        severity: "warning"
      });
    }
  }
  
  // Check for unclosed braces
  if (braceBalance > 0) {
    const lastBrace = braceStack[braceStack.length - 1] || { line: 0, character: 0 };
    errors.push({
      range: {
        start: lastBrace,
        end: { line: lastBrace.line, character: lastBrace.character + 1 }
      },
      message: `Unclosed braces: ${braceBalance} closing brace(s) expected`,
      severity: "error"
    });
  }
  
  // Check for unclosed parentheses
  if (parenBalance > 0) {
    const lastParen = parenStack[parenStack.length - 1] || { line: lines.length - 1, character: 0 };
    errors.push({
      range: {
        start: lastParen,
        end: { line: lastParen.line, character: lastParen.character + 1 }
      },
      message: `Unclosed parentheses: ${parenBalance} closing parenthesis expected`,
      severity: "error"
    });
  }

  // Check for unclosed brackets
  if (bracketBalance > 0) {
    const lastBracket = bracketStack[bracketStack.length - 1] || { line: lines.length - 1, character: 0 };
    errors.push({
      range: {
        start: lastBracket,
        end: { line: lastBracket.line, character: lastBracket.character + 1 }
      },
      message: `Unclosed brackets: ${bracketBalance} closing bracket(s) expected`,
      severity: "error"
    });
  }

  return { errors, warnings, components };
}

/**
 * Extract word at position for hover and completion
 */
export function getWordAtPosition(text: string, line: number, character: number): string | null {
  const lines = text.split("\n");
  if (line >= lines.length) {
    return null;
  }
  
  const currentLine = lines[line];
  if (character >= currentLine.length) {
    return null;
  }
  
  // Find word boundaries
  let start = character;
  let end = character;
  
  // Move start backward to find beginning of word
  while (start > 0 && /[\w.]/.test(currentLine[start - 1])) {
    start--;
  }
  
  // Move end forward to find end of word
  while (end < currentLine.length && /[\w.]/.test(currentLine[end])) {
    end++;
  }
  
  if (start === end) {
    return null;
  }
  
  return currentLine.substring(start, end);
}

/**
 * Check if a position is inside a string literal
 */
export function isInString(text: string, line: number, character: number): boolean {
  return isInStringUtil(text, line, character);
}

/**
 * Get the context at a position (component, applicator, argument, etc.)
 */
export function getContextAtPosition(
  text: string, 
  line: number, 
  character: number
): "component" | "applicator" | "argument" | "reference" | "unknown" {
  const lines = text.split("\n");
  if (line >= lines.length) {
    return "unknown";
  }
  
  const currentLine = lines[line];
  const beforeCursor = currentLine.substring(0, character);
  
  // Check for applicator context (after a dot)
  if (/\.\s*\w*$/.test(beforeCursor)) {
    return "applicator";
  }
  
  // Check for reference context (after @)
  if (/@\w*$/.test(beforeCursor)) {
    return "reference";
  }
  
  // Check for argument context (inside parentheses)
  const openParen = beforeCursor.lastIndexOf("(");
  const closeParen = beforeCursor.lastIndexOf(")");
  if (openParen > closeParen) {
    return "argument";
  }
  
  // Check for component context (beginning of line or after brace)
  if (/^\s*[A-Z]\w*/.test(currentLine.trim())) {
    return "component";
  }
  
  return "unknown";
}

// NOTE: WASM parser integration is implemented above via initWasmParser(),
// parseWithWasm(), and convertWasmComponent(). parseHypenDocument() will
// automatically use the WASM parser when available, falling back to the
// regex-based parser otherwise.
