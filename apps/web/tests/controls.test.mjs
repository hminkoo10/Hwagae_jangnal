import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Compile the actual controls and dialog module; no browser automation required.
const folder = await mkdtemp(
  path.join(process.cwd(), "node_modules/.hwagae-controls-"),
);
let controls;
let fields;
let language;
try {
  for (const name of [
    "ui",
    "controls",
    "product-fields",
    "merchant-language",
  ]) {
    const source = await readFile(
      new URL(
        name === "merchant-language"
          ? "../src/lib/merchant-language.ts"
          : `../src/components/${name}.tsx`,
        import.meta.url,
      ),
      "utf8",
    );
    let code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    code = code
      .replace('from "./ui"', 'from "./ui.mjs"')
      .replace('from "./controls"', 'from "./controls.mjs"')
      .replace(
        'from "@/lib/merchant-language"',
        'from "./merchant-language.mjs"',
      )
      .replace('from "@/lib/api"', 'from "./api.mjs"');
    await writeFile(path.join(folder, `${name}.mjs`), code);
  }
  await writeFile(
    path.join(folder, "api.mjs"),
    "export const shortDate=x=>x; export const units=x=>x;",
  );
  controls = await import(
    pathToFileURL(path.join(folder, "controls.mjs")).href
  );
  fields = await import(
    pathToFileURL(path.join(folder, "product-fields.mjs")).href
  );
  language = await import(
    pathToFileURL(path.join(folder, "merchant-language.mjs")).href
  );
} finally {
  assert.ok(
    path
      .resolve(folder)
      .startsWith(path.resolve(process.cwd(), "node_modules") + path.sep),
  );
  assert.ok(path.basename(folder).startsWith(".hwagae-controls-"));
  await rm(folder, { recursive: true, force: true });
}

test("price adjustment uses 100 won, keeps off-step prices and clamps supported limits", () => {
  assert.equal(language.adjustPrice("950", 1), "1050");
  assert.equal(language.adjustPrice("950", -1), "850");
  assert.equal(language.adjustPrice("50", -1), "0");
  assert.equal(language.adjustPrice("999950", 1), "1000000");
  assert.equal(language.adjustPrice("", 1), "100");
  const html = renderToStaticMarkup(
    React.createElement(fields.PriceField, {
      name: "cost",
      label: "한 개를 사오는 가격",
      defaultValue: 950,
    }),
  );
  assert.match(html, /name="cost"/);
  assert.match(html, /value="950"/);
  assert.match(html, /100원 올리기/);
  assert.match(html, /100원 내리기/);
  assert.match(html, /step="1"/); // Direct entry still accepts 950, without a step mismatch.
});

test("product categories are a single choice and preserve existing imported categories", () => {
  const html = renderToStaticMarkup(
    React.createElement(fields.ProductCategoryField, { value: "수입 간식" }),
  );
  assert.match(html, /name="category"/);
  assert.match(html, /value="수입 간식"/);
  assert.match(html, /수입 간식/);
  assert.doesNotMatch(html, /multiple/);
  assert.deepEqual(
    language
      .categoryOptions([{ category: "유제품" }, { category: "수입 간식" }])
      .filter((x) => x === "유제품"),
    ["유제품"],
  );
  const products = [
    { id: "P001", name: "우유", category: "유제품", supplier: "화개푸드" },
    { id: "P002", name: "커피", category: "음료", supplier: "커피사" },
  ];
  assert.equal(language.filterProducts(products, "", "유제품").length, 1);
  assert.equal(
    language.filterProducts(products, " 커피사 ", "음료")[0].id,
    "P002",
  );
  assert.equal(language.filterProducts(products, "P001", "음료").length, 0);
});

test("missing-history copy explains the next action without turning missing days into zero sales", () => {
  const korean = language.forecastHelp(
    "기준일까지 연속 56일 판매 기록이 필요합니다. 현재 55/56일이며 누락일은 0으로 채우지 않습니다.",
  );
  const english = language.forecastHelp(
    "requires 56 consecutive observed sales days through as_of; received 55/56",
  );
  assert.equal(korean.title, "판매 기록 하루만 더 확인해주세요");
  assert.deepEqual(korean, english);
  assert.match(korean.description, /실제로 안 팔린 날만 0개/);
  assert.equal(language.forecastHelp(null).action, "판매 기록 확인하기");
});

test("custom choice submits the selected model and retains disabled/required state", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      controls.Select,
      { name: "model", value: "second", required: true },
      React.createElement("option", { value: "first" }, "기본 모델"),
      React.createElement("option", { value: "second" }, "선택 모델"),
    ),
  );
  assert.match(
    html,
    /name="model"[^>]*required=""[^>]*value="second"|name="model"[^>]*value="second"/,
  );
  assert.match(html, /선택 모델/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.doesNotMatch(html, /<select/);
  assert.ok(
    html.indexOf("<button") < html.indexOf("<input"),
    "label activates the visible trigger rather than the validation field",
  );
});

test("date field preserves ISO form values without opening a native date control", () => {
  const html = renderToStaticMarkup(
    React.createElement(controls.DateField, {
      name: "order_date",
      value: "2024-02-29",
      min: "2024-02-28",
      max: "2024-03-06",
      required: true,
    }),
  );
  assert.match(html, /value="2024-02-29"/);
  assert.match(html, /2024\. 02\. 29/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /type="date"/);
});

test("responsive cards keep header labels, numeric zero and full-width summary rows", () => {
  const h = React.createElement;
  const html = renderToStaticMarkup(
    h(
      controls.ResponsiveTable,
      null,
      h(
        "thead",
        null,
        h("tr", null, h("th", null, "상품"), h("th", null, "재고")),
      ),
      h(
        "tbody",
        null,
        h("tr", null, h("td", null, "우유"), h("td", null, 0)),
        h("tr", null, h("td", { colSpan: 2 }, "합계")),
      ),
    ),
  );
  assert.match(html, /data-label="상품"/);
  assert.match(html, /data-label="재고"[^>]*>0/);
  assert.match(html, /data-wide="true"/);
});
