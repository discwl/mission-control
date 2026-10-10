// Dependency-free readers for the providers' config formats: JSON with comments (JSONC) and TOML.
// Errors give only a line and column, never text from the file, which may hold keys or tokens.

export class ConfigParseError extends Error {
  constructor(readonly format: "JSONC" | "TOML", readonly line: number, readonly column: number, reason: string) {
    super(`Invalid ${format} at line ${line}, column ${column}: ${reason}.`);
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

class Cursor {
  index = 0;
  constructor(readonly text: string, readonly format: "JSONC" | "TOML") {
    // A byte order mark is not content.
    if (text.charCodeAt(0) === 0xfeff) this.index = 1;
  }
  get done() { return this.index >= this.text.length; }
  peek(offset = 0) { return this.text[this.index + offset] ?? ""; }
  startsWith(value: string) { return this.text.startsWith(value, this.index); }
  fail(reason: string, at = this.index): never {
    const before = this.text.slice(0, at);
    const line = before.split("\n").length;
    const column = at - (before.lastIndexOf("\n") + 1) + 1;
    throw new ConfigParseError(this.format, line, column, reason);
  }
}

const HEX = /^[0-9a-fA-F]+$/;

function unicode(cursor: Cursor, length: number): string {
  const digits = cursor.text.slice(cursor.index, cursor.index + length);
  if (digits.length !== length || !HEX.test(digits)) cursor.fail("invalid unicode escape");
  const code = parseInt(digits, 16);
  if (code > 0x10ffff) cursor.fail("invalid unicode escape");
  cursor.index += length;
  return String.fromCodePoint(code);
}

// ---------- JSONC ----------

function skipJsonTrivia(cursor: Cursor) {
  while (!cursor.done) {
    const char = cursor.peek();
    if (char === " " || char === "\t" || char === "\n" || char === "\r") { cursor.index++; continue; }
    if (cursor.startsWith("//")) {
      while (!cursor.done && cursor.peek() !== "\n") cursor.index++;
      continue;
    }
    if (cursor.startsWith("/*")) {
      const end = cursor.text.indexOf("*/", cursor.index + 2);
      if (end < 0) cursor.fail("unterminated comment");
      cursor.index = end + 2;
      continue;
    }
    return;
  }
}

const JSON_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function jsonString(cursor: Cursor): string {
  const start = cursor.index;
  cursor.index++;
  let value = "";
  while (true) {
    if (cursor.done) cursor.fail("unterminated string", start);
    const char = cursor.peek();
    if (char === '"') { cursor.index++; return value; }
    if (char === "\n") cursor.fail("unterminated string", start);
    if (char === "\\") {
      const escape = cursor.peek(1);
      cursor.index += 2;
      if (escape === "u") {
        // Surrogate pairs arrive as two escapes; joining the halves gives the character.
        const digits = cursor.text.slice(cursor.index, cursor.index + 4);
        if (digits.length !== 4 || !HEX.test(digits)) cursor.fail("invalid unicode escape");
        value += String.fromCharCode(parseInt(digits, 16));
        cursor.index += 4;
      } else if (escape in JSON_ESCAPES) value += JSON_ESCAPES[escape];
      else cursor.fail("invalid escape", cursor.index - 2);
      continue;
    }
    value += char;
    cursor.index++;
  }
}

function jsonValue(cursor: Cursor, depth: number): Json {
  if (depth > 200) cursor.fail("nesting is too deep");
  skipJsonTrivia(cursor);
  const char = cursor.peek();
  if (char === "{") {
    cursor.index++;
    const result: { [key: string]: Json } = {};
    while (true) {
      skipJsonTrivia(cursor);
      if (cursor.peek() === "}") { cursor.index++; return result; }
      if (cursor.peek() !== '"') cursor.fail("expected a property name or '}'");
      const key = jsonString(cursor);
      skipJsonTrivia(cursor);
      if (cursor.peek() !== ":") cursor.fail("expected ':'");
      cursor.index++;
      Object.defineProperty(result, key, { value: jsonValue(cursor, depth + 1), enumerable: true, writable: true, configurable: true });
      skipJsonTrivia(cursor);
      if (cursor.peek() === ",") { cursor.index++; continue; }
      if (cursor.peek() === "}") { cursor.index++; return result; }
      cursor.fail("expected ',' or '}'");
    }
  }
  if (char === "[") {
    cursor.index++;
    const result: Json[] = [];
    while (true) {
      skipJsonTrivia(cursor);
      if (cursor.peek() === "]") { cursor.index++; return result; }
      result.push(jsonValue(cursor, depth + 1));
      skipJsonTrivia(cursor);
      if (cursor.peek() === ",") { cursor.index++; continue; }
      if (cursor.peek() === "]") { cursor.index++; return result; }
      cursor.fail("expected ',' or ']'");
    }
  }
  if (char === '"') return jsonString(cursor);
  for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
    if (cursor.startsWith(word)) { cursor.index += word.length; return value; }
  }
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(cursor.text.slice(cursor.index, cursor.index + 400));
  if (number) { cursor.index += number[0].length; return Number(number[0]); }
  cursor.fail(cursor.done ? "unexpected end of file" : "expected a value");
}

/** JSON plus `//` and block comments and trailing commas, as OpenCode and VS Code accept. */
export function parseJsonc(text: string): unknown {
  const cursor = new Cursor(text, "JSONC");
  const value = jsonValue(cursor, 0);
  skipJsonTrivia(cursor);
  if (!cursor.done) cursor.fail("unexpected content after the value");
  return value;
}

// ---------- TOML ----------

type TomlTable = { [key: string]: unknown };
// Tables made by [header] or dotted keys may gain keys later; inline tables and plain values may not.
const sealed = new WeakSet<object>();
const explicit = new WeakSet<object>();

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipSpaces(cursor: Cursor) {
  while (cursor.peek() === " " || cursor.peek() === "\t") cursor.index++;
}

function skipComment(cursor: Cursor) {
  if (cursor.peek() === "#") while (!cursor.done && cursor.peek() !== "\n") cursor.index++;
}

/** After a value or header: spaces, an optional comment, then a newline or the end. */
function endOfLine(cursor: Cursor) {
  skipSpaces(cursor);
  skipComment(cursor);
  if (cursor.done) return;
  if (cursor.startsWith("\r\n")) { cursor.index += 2; return; }
  if (cursor.peek() === "\n") { cursor.index++; return; }
  cursor.fail("expected the end of the line");
}

/** Whitespace, newlines and comments inside arrays. */
function skipArrayTrivia(cursor: Cursor) {
  while (!cursor.done) {
    const char = cursor.peek();
    if (char === " " || char === "\t" || char === "\n" || char === "\r") { cursor.index++; continue; }
    if (char === "#") { skipComment(cursor); continue; }
    return;
  }
}

const TOML_ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

function tomlBasicString(cursor: Cursor, multiline: boolean): string {
  const start = cursor.index;
  cursor.index += multiline ? 3 : 1;
  if (multiline) {
    // A newline straight after the opening quotes is trimmed.
    if (cursor.startsWith("\r\n")) cursor.index += 2; else if (cursor.peek() === "\n") cursor.index++;
  }
  let value = "";
  while (true) {
    if (cursor.done) cursor.fail("unterminated string", start);
    if (multiline && cursor.startsWith('"""')) {
      // Up to two quotes may sit right before the closing delimiter.
      let extra = 0;
      while (extra < 2 && cursor.peek(3 + extra) === '"') extra++;
      value += '"'.repeat(extra);
      cursor.index += 3 + extra;
      return value;
    }
    const char = cursor.peek();
    if (!multiline && char === '"') { cursor.index++; return value; }
    if (!multiline && (char === "\n" || char === "\r")) cursor.fail("unterminated string", start);
    if (char === "\\") {
      const escape = cursor.peek(1);
      if (multiline && /[ \t\r\n]/.test(escape)) {
        // A line-ending backslash removes the newline and the whitespace after it.
        let probe = cursor.index + 1;
        while (cursor.text[probe] === " " || cursor.text[probe] === "\t") probe++;
        if (cursor.text[probe] === "\n" || cursor.text.startsWith("\r\n", probe)) {
          cursor.index = probe;
          while (/[ \t\r\n]/.test(cursor.peek())) cursor.index++;
          continue;
        }
        cursor.fail("invalid escape");
      }
      cursor.index += 2;
      if (escape === "u") value += unicode(cursor, 4);
      else if (escape === "U") value += unicode(cursor, 8);
      else if (escape in TOML_ESCAPES) value += TOML_ESCAPES[escape];
      else cursor.fail("invalid escape", cursor.index - 2);
      continue;
    }
    value += char;
    cursor.index++;
  }
}

function tomlLiteralString(cursor: Cursor, multiline: boolean): string {
  const start = cursor.index;
  cursor.index += multiline ? 3 : 1;
  if (multiline) {
    if (cursor.startsWith("\r\n")) cursor.index += 2; else if (cursor.peek() === "\n") cursor.index++;
    const end = cursor.text.indexOf("'''", cursor.index);
    if (end < 0) cursor.fail("unterminated string", start);
    let extra = 0;
    while (extra < 2 && cursor.text[end + 3 + extra] === "'") extra++;
    const value = cursor.text.slice(cursor.index, end + extra);
    cursor.index = end + 3 + extra;
    return value;
  }
  const end = cursor.text.indexOf("'", cursor.index);
  const newline = cursor.text.indexOf("\n", cursor.index);
  if (end < 0 || (newline >= 0 && newline < end)) cursor.fail("unterminated string", start);
  const value = cursor.text.slice(cursor.index, end);
  cursor.index = end + 1;
  return value;
}

function tomlKey(cursor: Cursor): string[] {
  const parts: string[] = [];
  while (true) {
    skipSpaces(cursor);
    const char = cursor.peek();
    if (char === '"') parts.push(tomlBasicString(cursor, false));
    else if (char === "'") parts.push(tomlLiteralString(cursor, false));
    else {
      const bare = /^[A-Za-z0-9_-]+/.exec(cursor.text.slice(cursor.index, cursor.index + 400));
      if (!bare) cursor.fail("expected a key");
      parts.push(bare[0]);
      cursor.index += bare[0].length;
    }
    skipSpaces(cursor);
    if (cursor.peek() !== ".") return parts;
    cursor.index++;
  }
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;

function tomlValue(cursor: Cursor, depth: number): unknown {
  if (depth > 100) cursor.fail("nesting is too deep");
  const char = cursor.peek();
  if (cursor.startsWith('"""')) return tomlBasicString(cursor, true);
  if (char === '"') return tomlBasicString(cursor, false);
  if (cursor.startsWith("'''")) return tomlLiteralString(cursor, true);
  if (char === "'") return tomlLiteralString(cursor, false);
  if (char === "[") {
    cursor.index++;
    const result: unknown[] = [];
    while (true) {
      skipArrayTrivia(cursor);
      if (cursor.peek() === "]") { cursor.index++; return result; }
      result.push(tomlValue(cursor, depth + 1));
      skipArrayTrivia(cursor);
      if (cursor.peek() === ",") { cursor.index++; continue; }
      if (cursor.peek() === "]") { cursor.index++; return result; }
      cursor.fail("expected ',' or ']'");
    }
  }
  if (char === "{") {
    cursor.index++;
    const result: TomlTable = {};
    skipSpaces(cursor);
    if (cursor.peek() === "}") { cursor.index++; sealed.add(result); return result; }
    while (true) {
      const keyAt = cursor.index;
      const key = tomlKey(cursor);
      if (cursor.peek() !== "=") cursor.fail("expected '='");
      cursor.index++;
      skipSpaces(cursor);
      assign(cursor, result, key, tomlValue(cursor, depth + 1), keyAt);
      skipSpaces(cursor);
      if (cursor.peek() === ",") { cursor.index++; continue; }
      if (cursor.peek() === "}") { cursor.index++; sealed.add(result); return result; }
      cursor.fail("expected ',' or '}'");
    }
  }
  const rest = cursor.text.slice(cursor.index, cursor.index + 200);
  const date = DATE_TIME.exec(rest);
  if (date) { cursor.index += date[0].length; return date[0]; }
  for (const [word, value] of [["true", true], ["false", false], ["inf", Infinity], ["+inf", Infinity], ["-inf", -Infinity], ["nan", NaN], ["+nan", NaN], ["-nan", NaN]] as const) {
    if (rest.startsWith(word) && !/[A-Za-z0-9_]/.test(rest[word.length] ?? "")) { cursor.index += word.length; return value; }
  }
  const radix = /^0([xob])([0-9A-Fa-f_]+)/.exec(rest);
  if (radix) {
    const digits = radix[2].replaceAll("_", "");
    const value = parseInt(digits, radix[1] === "x" ? 16 : radix[1] === "o" ? 8 : 2);
    if (Number.isNaN(value)) cursor.fail("invalid number");
    cursor.index += radix[0].length;
    return value;
  }
  const number = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest);
  if (number && number[0] !== "+" && number[0] !== "-") {
    cursor.index += number[0].length;
    return Number(number[0].replaceAll("_", ""));
  }
  cursor.fail(cursor.done ? "unexpected end of file" : "expected a value");
}

/** Sets `path` under `table`, creating dotted-key tables on the way. */
function assign(cursor: Cursor, table: TomlTable, path: string[], value: unknown, at: number) {
  let current = table;
  for (const part of path.slice(0, -1)) {
    if (!Object.hasOwn(current, part)) {
      const child: TomlTable = {};
      define(current, part, child);
      current = child;
      continue;
    }
    const next = current[part];
    if (!isTable(next) || sealed.has(next)) cursor.fail("a key is defined twice", at);
    current = next;
  }
  const last = path[path.length - 1];
  if (Object.hasOwn(current, last)) cursor.fail("a key is defined twice", at);
  define(current, last, value);
}

// Keys like "__proto__" become plain properties rather than changing the object's prototype.
function define(table: TomlTable, key: string, value: unknown) {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Finds or creates the table a `[header]` or `[[header]]` names. */
function openTable(cursor: Cursor, root: TomlTable, path: string[], arrayTable: boolean, at: number): TomlTable {
  let current = root;
  path.forEach((part, index) => {
    const last = index === path.length - 1;
    if (last && arrayTable) {
      if (!Object.hasOwn(current, part)) define(current, part, []);
      const list = current[part];
      if (!Array.isArray(list) || sealed.has(list)) cursor.fail("a key is defined twice", at);
      const entry: TomlTable = {};
      explicit.add(entry);
      list.push(entry);
      current = entry;
      return;
    }
    if (!Object.hasOwn(current, part)) {
      const child: TomlTable = {};
      define(current, part, child);
      current = child;
    } else {
      const next = current[part];
      // [a.b] after [[a]] adds to the latest entry of a.
      const target = Array.isArray(next) && !sealed.has(next) ? next[next.length - 1] : next;
      if (!isTable(target) || sealed.has(target)) cursor.fail("a key is defined twice", at);
      if (last && explicit.has(target)) cursor.fail("a table is defined twice", at);
      current = target;
    }
    if (last) explicit.add(current);
  });
  return current;
}

/**
 * TOML 1.0 as Codex's config uses it: tables, array tables, dotted and quoted keys, all string forms,
 * integers, floats, booleans, arrays and inline tables. Dates and times are kept as their text.
 */
export function parseToml(text: string): Record<string, unknown> {
  const cursor = new Cursor(text, "TOML");
  const root: TomlTable = {};
  let table = root;
  while (!cursor.done) {
    skipSpaces(cursor);
    const char = cursor.peek();
    if (char === "\n" || char === "\r" || char === "#" || cursor.done) { endOfLine(cursor); continue; }
    const at = cursor.index;
    if (char === "[") {
      const arrayTable = cursor.peek(1) === "[";
      cursor.index += arrayTable ? 2 : 1;
      const path = tomlKey(cursor);
      if (!cursor.startsWith(arrayTable ? "]]" : "]")) cursor.fail(arrayTable ? "expected ']]'" : "expected ']'");
      cursor.index += arrayTable ? 2 : 1;
      table = openTable(cursor, root, path, arrayTable, at);
      endOfLine(cursor);
      continue;
    }
    const key = tomlKey(cursor);
    if (cursor.peek() !== "=") cursor.fail("expected '='");
    cursor.index++;
    skipSpaces(cursor);
    const value = tomlValue(cursor, 0);
    if (Array.isArray(value)) sealed.add(value);
    assign(cursor, table, key, value, at);
    endOfLine(cursor);
  }
  return root;
}
