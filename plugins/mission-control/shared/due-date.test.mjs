import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { byDueDate, dueLabel, localToday } = require("./due-date.ts");
const { dueDateSchema } = require("./tasks.ts");

test("due labels count calendar days from today", () => {
  assert.deepEqual(dueLabel("2026-10-07", "2026-10-07"), { text: "Due today", tone: "soon" });
  assert.deepEqual(dueLabel("2026-10-08", "2026-10-07"), { text: "Due tomorrow", tone: "soon" });
  assert.deepEqual(dueLabel("2026-10-10", "2026-10-07"), { text: "Due Oct 10", tone: "soon" });
  assert.deepEqual(dueLabel("2026-10-22", "2026-10-07"), { text: "Due Oct 22", tone: "later" });
  assert.deepEqual(dueLabel("2026-10-06", "2026-10-07"), { text: "Overdue · due Oct 6", tone: "overdue" });
  assert.deepEqual(dueLabel("2027-01-01", "2026-12-31"), { text: "Due tomorrow", tone: "soon" }, "across a year boundary");
});

test("earliest due date sorts first, and tasks without one keep their order at the end", () => {
  const tasks = [{ id: "a" }, { id: "b", dueDate: "2026-10-22" }, { id: "c" }, { id: "d", dueDate: "2026-10-08" }];
  assert.deepEqual(tasks.slice().sort(byDueDate).map(task => task.id), ["d", "b", "a", "c"]);
});

test("today is the device's calendar day, and only real dates are accepted", () => {
  assert.equal(localToday(new Date(2026, 9, 7, 23, 59)), "2026-10-07");
  assert.equal(dueDateSchema.safeParse("2026-10-08").success, true);
  assert.equal(dueDateSchema.safeParse("2026-02-30").success, false);
  assert.equal(dueDateSchema.safeParse("10/08/2026").success, false);
});