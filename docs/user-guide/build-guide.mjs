// Builds the standalone user guide: inlines every screenshots/*.png that guide.html references.
// Usage: node docs/user-guide/build-guide.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(folder, "guide.html"), "utf8");
const missing = [];
// A screenshot not taken yet becomes a small "pending" placeholder, so the standalone file never shows a broken image.
const pending = name => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="880" height="200"><rect width="880" height="200" rx="10" fill="#f6f8fa" stroke="#d0d7de"/><text x="440" y="96" font-family="Segoe UI, sans-serif" font-size="18" fill="#59636e" text-anchor="middle">Screenshot pending: ${name}</text><text x="440" y="126" font-family="Segoe UI, sans-serif" font-size="14" fill="#8c959f" text-anchor="middle">Capture unavailable; see guide screenshot coverage.</text></svg>`).toString("base64")}`;
const output = source.replace(/src="(screenshots\/([a-z0-9-]+)\.png)"/g, (match, path, name) => {
  const file = join(folder, path);
  if (!existsSync(file)) { missing.push(path); return `src="${pending(name)}"`; }
  return `src="data:image/png;base64,${readFileSync(file).toString("base64")}"`;
});
const target = join(folder, "mission-control-user-guide.html");
writeFileSync(target, output);
console.log(`wrote ${target} (${Math.round(Buffer.byteLength(output) / 1024)} KB)${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
