// Format-preserving edits for the providers' config files: one key in a TOML table, one member or array item in JSONC.
// Everything outside the edited span is kept byte for byte: comments, spacing, line endings, key order and trailing commas.
// These scanners assume the text already parsed with config-parsers; they locate spans, they don't validate.
// Errors never quote the file, which may hold keys or tokens.

export class ConfigEditError extends Error {}

const eolOf = (text: string) => text.includes("\r\n") ? "\r\n" : "\n";
const start = (text: string) => text.charCodeAt(0) === 0xfeff ? 1 : 0;
const lineStartOf = (text: string, index: number) => text.lastIndexOf("\n", index - 1) + 1;
const indentAt = (text: string, index: number) => /^[ \t]*/.exec(text.slice(lineStartOf(text, index)))![0];

/** Applies non-overlapping replacements, given in any order. */
function splice(text: string, edits: { from: number; to: number; insert: string }[]) {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return result;
}

// ---------- TOML ----------

interface TomlHeader { path: string[]; array: boolean; start: number; lineEnd: number }
interface TomlEntry { table: string[]; key: string[]; lineStart: number; keyStart: number; valueStart: number; valueEnd: number; lineEnd: number }

function tomlBasicEnd(text: string, index: number, quote: string): number {
  const multiline = text.startsWith(quote.repeat(3), index);
  let at = index + (multiline ? 3 : 1);
  while (at < text.length) {
    if (quote === '"' && text[at] === "\\") { at += 2; continue; }
    if (multiline && text.startsWith(quote.repeat(3), at)) {
      let end = at + 3;
      while (end < at + 5 && text[end] === quote) end++;
      return end;
    }
    if (!multiline && text[at] === quote) return at + 1;
    at++;
  }
  throw new ConfigEditError("unterminated string");
}

function tomlKey(text: string, index: number): { parts: string[]; end: number } {
  const parts: string[] = [];
  let at = index;
  while (true) {
    while (text[at] === " " || text[at] === "\t") at++;
    if (text[at] === '"' || text[at] === "'") {
      const end = tomlBasicEnd(text, at, text[at]);
      const raw = text.slice(at + 1, end - 1);
      if (text[at] === "'") parts.push(raw);
      else { try { parts.push(JSON.parse(`"${raw}"`)); } catch { parts.push(raw); } }
      at = end;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(at, at + 400));
      if (!bare) throw new ConfigEditError("expected a key");
      parts.push(bare[0]);
      at += bare[0].length;
    }
    while (text[at] === " " || text[at] === "\t") at++;
    if (text[at] !== ".") return { parts, end: at };
    at++;
  }
}

/** The end of a TOML value starting at `index`: strings, nested arrays and inline tables, or a scalar up to the comment. */
function tomlValueEnd(text: string, index: number): number {
  const char = text[index];
  if (char === '"' || char === "'") return tomlBasicEnd(text, index, char);
  if (char === "[" || char === "{") {
    let depth = 0;
    let at = index;
    while (at < text.length) {
      const current = text[at];
      if (current === '"' || current === "'") { at = tomlBasicEnd(text, at, current); continue; }
      if (current === "#") { while (at < text.length && text[at] !== "\n") at++; continue; }
      if (current === "[" || current === "{") depth++;
      if (current === "]" || current === "}") { depth--; if (depth === 0) return at + 1; }
      at++;
    }
    throw new ConfigEditError("unterminated array or table");
  }
  let at = index;
  while (at < text.length && text[at] !== "#" && text[at] !== "\n" && text[at] !== "\r") at++;
  while (at > index && (text[at - 1] === " " || text[at - 1] === "\t")) at--;
  return at;
}

/** After a value or header: spaces, a comment and the newline. Returns the index after the newline. */
function tomlLineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline + 1;
}

export function scanToml(text: string): { headers: TomlHeader[]; entries: TomlEntry[] } {
  const headers: TomlHeader[] = [];
  const entries: TomlEntry[] = [];
  let table: string[] = [];
  let at = start(text);
  while (at < text.length) {
    const lineStart = at;
    while (text[at] === " " || text[at] === "\t") at++;
    if (at >= text.length) break;
    const char = text[at];
    if (char === "\n" || char === "\r" || char === "#") { at = tomlLineEnd(text, at); continue; }
    if (char === "[") {
      const array = text[at + 1] === "[";
      const key = tomlKey(text, at + (array ? 2 : 1));
      table = key.parts;
      const lineEnd = tomlLineEnd(text, key.end);
      headers.push({ path: key.parts, array, start: lineStart, lineEnd });
      at = lineEnd;
      continue;
    }
    const key = tomlKey(text, at);
    if (text[key.end] !== "=") throw new ConfigEditError("expected '='");
    let valueStart = key.end + 1;
    while (text[valueStart] === " " || text[valueStart] === "\t") valueStart++;
    const valueEnd = tomlValueEnd(text, valueStart);
    const lineEnd = tomlLineEnd(text, valueEnd);
    entries.push({ table, key: key.parts, lineStart, keyStart: at, valueStart, valueEnd, lineEnd });
    at = lineEnd;
  }
  return { headers, entries };
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((part, index) => part === b[index]);

/** The `[table]` header (not an array table) for `path`, or null when the table is written inline or with dotted keys. */
export function tomlTable(text: string, path: string[]) {
  const scan = scanToml(text);
  const header = scan.headers.find(item => !item.array && samePath(item.path, path)) ?? null;
  if (!header) return null;
  const next = scan.headers.find(item => item.start > header.start);
  const entries = scan.entries.filter(entry => entry.lineStart > header.start && (!next || entry.lineStart < next.start) && samePath(entry.table, path));
  return { header, entries };
}

/** Sets `key` in the `[table]` at `path` to a boolean, or removes it when `value` is null. Only that line changes. */
export function setTomlKey(text: string, path: string[], key: string, value: boolean | null): string {
  const table = tomlTable(text, path);
  if (!table) throw new ConfigEditError("the table isn't written as a [table] header");
  const entry = table.entries.find(item => samePath(item.key, [key]));
  if (entry) {
    if (value === null) {
      // A comment on the line was written by someone; removing the key leaves it on its own line.
      const comment = text.slice(entry.valueEnd, entry.lineEnd).indexOf("#");
      if (comment >= 0) return splice(text, [{ from: entry.keyStart, to: entry.valueEnd + comment, insert: "" }]);
      return splice(text, [{ from: entry.lineStart, to: entry.lineEnd, insert: "" }]);
    }
    return splice(text, [{ from: entry.valueStart, to: entry.valueEnd, insert: String(value) }]);
  }
  if (value === null) return text;
  const last = table.entries[table.entries.length - 1];
  const at = last ? last.lineEnd : table.header.lineEnd;
  const eol = eolOf(text);
  const indent = last ? indentAt(text, last.lineStart) : "";
  const before = at > 0 && text[at - 1] !== "\n" ? eol : "";
  return splice(text, [{ from: at, to: at, insert: `${before}${indent}${key} = ${value}${eol}` }]);
}

// ---------- JSONC ----------

type JsonNode =
  | { kind: "object"; start: number; end: number; members: JsonMember[] }
  | { kind: "array"; start: number; end: number; items: JsonItem[] }
  | { kind: "scalar"; start: number; end: number; value: unknown };
interface JsonMember { key: string; keyStart: number; value: JsonNode; commaStart: number | null; commaEnd: number | null }
interface JsonItem { value: JsonNode; commaStart: number | null; commaEnd: number | null }

function skipTrivia(text: string, index: number): number {
  let at = index;
  while (at < text.length) {
    const char = text[at];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") { at++; continue; }
    if (text.startsWith("//", at)) { while (at < text.length && text[at] !== "\n") at++; continue; }
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) throw new ConfigEditError("unterminated comment");
      at = end + 2;
      continue;
    }
    return at;
  }
  return at;
}

function jsonStringEnd(text: string, index: number): number {
  let at = index + 1;
  while (at < text.length) {
    if (text[at] === "\\") { at += 2; continue; }
    if (text[at] === '"') return at + 1;
    at++;
  }
  throw new ConfigEditError("unterminated string");
}

/** JSON.parse for a token the scanner cut out, such as a string with a raw tab that JSONC allows but JSON doesn't. */
function token(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new ConfigEditError("a value can't be read"); }
}

function jsonNode(text: string, index: number): JsonNode {
  const at = skipTrivia(text, index);
  const char = text[at];
  if (char === "{" || char === "[") {
    const object = char === "{";
    const members: JsonMember[] = [];
    const items: JsonItem[] = [];
    let cursor = at + 1;
    while (true) {
      cursor = skipTrivia(text, cursor);
      if (text[cursor] === (object ? "}" : "]")) {
        return object ? { kind: "object", start: at, end: cursor + 1, members } : { kind: "array", start: at, end: cursor + 1, items };
      }
      let entry: JsonMember | JsonItem;
      if (object) {
        if (text[cursor] !== '"') throw new ConfigEditError("expected a property name");
        const keyEnd = jsonStringEnd(text, cursor);
        const key = token(text.slice(cursor, keyEnd)) as string;
        const colon = skipTrivia(text, keyEnd);
        if (text[colon] !== ":") throw new ConfigEditError("expected ':'");
        entry = { key, keyStart: cursor, value: jsonNode(text, colon + 1), commaStart: null, commaEnd: null };
        members.push(entry);
      } else {
        entry = { value: jsonNode(text, cursor), commaStart: null, commaEnd: null };
        items.push(entry);
      }
      cursor = skipTrivia(text, entry.value.end);
      if (text[cursor] === ",") { entry.commaStart = cursor; entry.commaEnd = cursor + 1; cursor++; }
    }
  }
  if (char === '"') {
    const end = jsonStringEnd(text, at);
    return { kind: "scalar", start: at, end, value: token(text.slice(at, end)) };
  }
  const word = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at, at + 400));
  if (!word) throw new ConfigEditError("expected a value");
  return { kind: "scalar", start: at, end: at + word[0].length, value: token(word[0]) };
}

export function scanJsonc(text: string): JsonNode {
  return jsonNode(text, start(text));
}

/** The node at `path` of object keys, or null. */
export function jsonAt(root: JsonNode, path: string[]): JsonNode | null {
  let node: JsonNode | null = root;
  for (const key of path) {
    if (!node || node.kind !== "object") return null;
    node = node.members.find(member => member.key === key)?.value ?? null;
  }
  return node;
}

/**
 * Non-null when only spaces, tabs and at most one comment sit between `from` and the end of its line.
 * `comment` is where that comment starts, or null.
 */
function restOfLineIsTrivia(text: string, from: number): { newline: number; comment: number | null } | null {
  const newline = text.indexOf("\n", from);
  const rest = text.slice(from, newline < 0 ? text.length : newline).replace(/\r$/, "");
  const match = /^([ \t]*)(\/\/.*|\/\*.*?\*\/[ \t]*)?$/.exec(rest);
  if (!match) return null;
  return { newline: newline < 0 ? text.length : newline, comment: match[2] ? from + match[1].length : null };
}

function insertMember(text: string, object: Extract<JsonNode, { kind: "object" }>, key: string, raw: string): string {
  const member = `${JSON.stringify(key)}: ${raw}`;
  const last = object.members[object.members.length - 1];
  if (!last) {
    const inside = text.slice(object.start + 1, object.end - 1);
    if (inside.includes("/")) throw new ConfigEditError("the object holds only comments");
    if (inside.includes("\n")) {
      const eol = eolOf(text);
      const indent = indentAt(text, object.start) + "  ";
      return splice(text, [{ from: object.start + 1, to: object.end - 1, insert: `${eol}${indent}${member}${eol}${indentAt(text, object.end - 1)}` }]);
    }
    return splice(text, [{ from: object.start + 1, to: object.end - 1, insert: ` ${member} ` }]);
  }
  const multiline = text.slice(object.start, object.members[0].keyStart).includes("\n");
  const trailing = last.commaEnd !== null;
  const after = last.commaEnd ?? last.value.end;
  if (multiline) {
    const line = restOfLineIsTrivia(text, after);
    if (line) {
      // A trailing comment stays with its member; the new member follows the style of trailing commas.
      const eol = eolOf(text);
      const insertAt = line.newline > 0 && text[line.newline - 1] === "\r" ? line.newline - 1 : line.newline;
      const edits = [{ from: insertAt, to: insertAt, insert: `${eol}${indentAt(text, last.keyStart)}${member}${trailing ? "," : ""}` }];
      if (!trailing) edits.push({ from: last.value.end, to: last.value.end, insert: "," });
      return splice(text, edits);
    }
  }
  return trailing
    ? splice(text, [{ from: after, to: after, insert: ` ${member},` }])
    : splice(text, [{ from: last.value.end, to: last.value.end, insert: `, ${member}` }]);
}

function removeMember(text: string, object: Extract<JsonNode, { kind: "object" }>, key: string): string {
  const index = object.members.findIndex(member => member.key === key);
  if (index < 0) return text;
  const member = object.members[index];
  const previous = object.members[index - 1];
  const next = object.members[index + 1];
  const own = text.slice(lineStartOf(text, member.keyStart), member.keyStart).trim() === "" ? restOfLineIsTrivia(text, member.commaEnd ?? member.value.end) : null;
  if (own) {
    // A comment on the member's line was written by someone; it stays on its own line.
    const edits = [own.comment === null
      ? { from: lineStartOf(text, member.keyStart), to: Math.min(own.newline + 1, text.length), insert: "" }
      : { from: member.keyStart, to: own.comment, insert: "" }];
    // The last member without a trailing comma leaves the one before it last too.
    if (!next && member.commaEnd === null && previous?.commaStart != null) edits.push({ from: previous.commaStart, to: previous.commaEnd!, insert: "" });
    return splice(text, edits);
  }
  const range = next ? { from: member.keyStart, to: next.keyStart }
    : previous ? { from: previous.value.end, to: member.commaEnd ?? member.value.end }
      : { from: object.start + 1, to: object.end - 1 };
  if (withoutStrings(text.slice(range.from, range.to)).includes("/")) throw new ConfigEditError("a comment sits next to the key");
  return splice(text, [{ ...range, insert: "" }]);
}

const withoutStrings = (slice: string) => slice.replace(/"(?:[^"\\]|\\.)*"/g, "");

/**
 * Sets the member at `path` (object keys) to a JSON value, or removes it when `raw` is null.
 * Every object on the way must exist, except the last key, which is added after the object's last member.
 */
export function setJsoncMember(text: string, path: string[], raw: string | null): string {
  const root = scanJsonc(text);
  const parent = jsonAt(root, path.slice(0, -1));
  if (!parent || parent.kind !== "object") throw new ConfigEditError("the parent object doesn't exist");
  const key = path[path.length - 1];
  const existing = parent.members.find(member => member.key === key);
  if (raw === null) return removeMember(text, parent, key);
  if (existing) return splice(text, [{ from: existing.value.start, to: existing.value.end, insert: raw }]);
  return insertMember(text, parent, key, raw);
}

/**
 * Adds a string to the array at `path`, creating the member if it's missing, or removes it.
 * Removing the last string removes the member, as Copilot does for disabledMcpServers.
 */
export function setJsoncListItem(text: string, path: string[], item: string, present: boolean): string {
  const root = scanJsonc(text);
  const node = jsonAt(root, path);
  if (node && node.kind !== "array") throw new ConfigEditError("the list isn't an array");
  const items = node?.kind === "array" ? node.items : [];
  const index = items.findIndex(entry => entry.value.kind === "scalar" && entry.value.value === item);
  if (present) {
    if (index >= 0) return text;
    if (!node || node.kind !== "array") return setJsoncMember(text, path, `[${JSON.stringify(item)}]`);
    const last = items[items.length - 1];
    if (!last) {
      if (text.slice(node.start + 1, node.end - 1).includes("/")) throw new ConfigEditError("the list holds only comments");
      return splice(text, [{ from: node.start + 1, to: node.end - 1, insert: JSON.stringify(item) }]);
    }
    const multiline = text.slice(node.start, items[0].value.start).includes("\n");
    const separator = multiline ? `${eolOf(text)}${indentAt(text, last.value.start)}` : " ";
    return last.commaEnd !== null
      ? splice(text, [{ from: last.commaEnd, to: last.commaEnd, insert: `${separator}${JSON.stringify(item)},` }])
      : splice(text, [{ from: last.value.end, to: last.value.end, insert: `,${separator}${JSON.stringify(item)}` }]);
  }
  if (index < 0 || !node || node.kind !== "array") return text;
  if (items.length === 1) return setJsoncMember(text, path, null);
  const entry = items[index];
  const range = index < items.length - 1
    ? { from: entry.value.start, to: items[index + 1].value.start }
    : { from: items[index - 1].value.end, to: entry.commaEnd ?? entry.value.end };
  // Keep the previous item's trailing comma when the removed last item had one.
  if (index === items.length - 1 && entry.commaEnd !== null) range.from = items[index - 1].commaEnd ?? items[index - 1].value.end;
  if (withoutStrings(text.slice(range.from, range.to)).includes("/")) throw new ConfigEditError("a comment sits next to the list item");
  return splice(text, [{ ...range, insert: "" }]);
}
