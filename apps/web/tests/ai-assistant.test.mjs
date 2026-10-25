import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const folder = await mkdtemp(path.join(process.cwd(), "node_modules/.hwagae-assistant-"));
let assistant, answer, memo, requests;
try {
  for (const name of ["ui", "controls", "ai-answer", "ai-assistant", "ai-memo", "merchant-language"]) {
    const source = await readFile(new URL(name === "merchant-language" ? `../src/lib/${name}.ts` : `../src/components/${name}.tsx`, import.meta.url), "utf8");
    let code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    for (const target of ["ui", "controls", "ai-answer", "ai-assistant"]) code = code.replaceAll(`from "./${target}"`, `from "./${target}.mjs"`);
    code = code.replaceAll('from "@/lib/api"', 'from "./api.mjs"');
    code = code.replaceAll('from "@/lib/merchant-language"', 'from "./merchant-language.mjs"');
    await writeFile(path.join(folder, `${name}.mjs`), code);
  }
  await writeFile(path.join(folder, "api.mjs"), `export let requests=0; export const api=()=>{ requests++; throw new Error('Unexpected automatic request'); }; export class ApiError extends Error {} export const units=x=>x; export const shortDate=x=>x; export const won=x=>x+'원';`);
  assistant = await import(pathToFileURL(path.join(folder, "ai-assistant.mjs")).href);
  answer = await import(pathToFileURL(path.join(folder, "ai-answer.mjs")).href);
  memo = await import(pathToFileURL(path.join(folder, "ai-memo.mjs")).href);
  requests = await import(pathToFileURL(path.join(folder, "api.mjs")).href);
} finally {
  assert.ok(path.resolve(folder).startsWith(path.resolve(process.cwd(), "node_modules") + path.sep));
  assert.ok(path.basename(folder).startsWith(".hwagae-assistant-"));
  await rm(folder, { recursive: true, force: true });
}

test("all merchant summaries and questions wait for an explicit action", () => {
  for (const tab of Object.keys(assistant.ASSISTANT_TASKS)) {
    const html = renderToStaticMarkup(React.createElement(assistant.AiAssistant, {
      token: "fixture", storeId: "gwangju", tab, asOf: "2026-10-25", onSetup() {},
    }));
    assert.ok(html.includes(assistant.ASSISTANT_TASKS[tab].action));
    assert.ok(html.includes("매장에 물어보기"));
    assert.ok(html.includes('maxLength="1200"'));
    assert.ok(html.includes("2026-10-25"));
  }
  assert.equal(requests.requests, 0);
});

test("provider text is displayed as escaped text rather than executable markup", () => {
  const html = renderToStaticMarkup(React.createElement(answer.AiAnswer, {
    text: '<script>stealKey()</script>\n- <img src=x onerror=stealKey()> 10월 27일(화) 12개',
  }));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>") && !html.includes("<img"));
  assert.ok(html.includes("<li") && html.includes("12개"));
});

test("sales and product memo helpers do not save or populate fields on mount", () => {
  const sales = renderToStaticMarkup(React.createElement(memo.AiSalesMemo, {
    token: "fixture", storeId: "gwangju", products: [], today: "2026-10-25", onSaved() { throw new Error("Unexpected save"); },
  }));
  assert.ok(sales.includes("메모로 판매 기록 입력"));
  assert.ok(sales.includes("disabled"));
  assert.ok(!sales.includes("건 저장"));
  const product = renderToStaticMarkup(React.createElement(memo.AiProductMemo, {
    token: "fixture", storeId: "gwangju", onApply() { throw new Error("Unexpected autofill"); },
  }));
  assert.ok(product.includes("상품 설명으로 입력 줄이기"));
  assert.ok(product.includes("가격·기간은 적어주신 내용만"));
  assert.equal(requests.requests, 0);
});

test("supplier text generation is explicit and includes no send control", () => {
  const html = renderToStaticMarkup(React.createElement(assistant.AiOrderMessage, { token: "fixture", storeId: "gwangju", orderId: "order-1" }));
  assert.ok(html.includes("전달 문구 만들기"));
  assert.ok(html.includes("저장한 수량"));
  assert.ok(!html.includes("전송하기"));
  assert.equal(requests.requests, 0);
});
