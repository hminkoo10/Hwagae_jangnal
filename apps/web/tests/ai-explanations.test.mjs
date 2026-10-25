import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const fixtureUrl = `data:text/javascript;base64,${Buffer.from(`export let count=0; export let fail=false; export function rejectNext(){fail=true} export function api(){count++; if(fail){fail=false;return Promise.reject(new Error('fixture failure'))} return Promise.resolve({text:'입고를 반영했어요',connection:{name:'AI',model:'fixture'},attempts:[],fallback_used:false})}`).toString("base64")}`;
const fixture = await import(fixtureUrl);
const source = await readFile(new URL("../src/lib/ai-explanations.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText.replace('from "./api"', `from "${fixtureUrl}"`);
const { explainOrder } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("automatic explanations reuse a single request for the same signed-in merchant and plan", async () => {
  const before = fixture.count;
  const first = explainOrder("user-one", "store-one", "plan-one");
  assert.equal(first, explainOrder("user-one", "store-one", "plan-one"));
  await first;
  assert.equal(first, explainOrder("user-one", "store-one", "plan-one"));
  await explainOrder("user-two", "store-one", "plan-one");
  await explainOrder("user-one", "store-two", "plan-one");
  assert.equal(fixture.count - before, 3);
});

test("failed explanations can be retried", async () => {
  fixture.rejectNext();
  await assert.rejects(explainOrder("retry-user", "store", "plan"));
  assert.ok((await explainOrder("retry-user", "store", "plan")).text);
});
