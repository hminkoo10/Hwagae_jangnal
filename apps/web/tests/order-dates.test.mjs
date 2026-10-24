import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { addCalendarDays, isOrderDateInWindow } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("order window includes the sales date and next six days across a month boundary", () => {
  assert.equal(addCalendarDays("2026-10-30", 6), "2026-11-05");
  assert.equal(isOrderDateInWindow("2026-10-30", "2026-10-30"), true);
  assert.equal(isOrderDateInWindow("2026-11-05", "2026-10-30"), true);
  assert.equal(isOrderDateInWindow("2026-10-29", "2026-10-30"), false);
  assert.equal(isOrderDateInWindow("2026-11-06", "2026-10-30"), false);
});

test("calendar dates remain stable across leap day and American daylight saving changes", () => {
  assert.equal(addCalendarDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addCalendarDays("2026-10-31", 2), "2026-11-02");
  assert.equal(addCalendarDays("2026-03-07", 2), "2026-03-09");
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
});

test("empty and impossible dates cannot enable order calculation", () => {
  assert.equal(isOrderDateInWindow("", "2026-10-24"), false);
  assert.equal(isOrderDateInWindow("2026-10-24", ""), false);
  assert.equal(isOrderDateInWindow("2026-02-30", "2026-02-27"), false);
  assert.equal(isOrderDateInWindow("2026-13-01", "2026-12-31"), false);
  assert.equal(isOrderDateInWindow("2026-3-07", "2026-03-07"), false);
});
