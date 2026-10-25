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
let summary;
let orderDetails;
let metrics;
let ui;
try {
  for (const name of [
    "ui",
    "controls",
    "product-fields",
    "merchant-language",
    "merchant-summary",
    "merchant-metrics",
    "order-details",
    "ai-answer",
    "ai-assistant",
  ]) {
    const source = await readFile(
      new URL(
        ["merchant-language", "merchant-summary"].includes(name)
          ? `../src/lib/${name}.ts`
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
      .replace('from "./ai-assistant"', 'from "./ai-assistant.mjs"')
      .replace('from "./ai-answer"', 'from "./ai-answer.mjs"')
      .replace('from "@/lib/merchant-summary"', 'from "./merchant-summary.mjs"')
      .replace(
        'from "@/lib/merchant-language"',
        'from "./merchant-language.mjs"',
      )
      .replace('from "@/lib/api"', 'from "./api.mjs"');
    await writeFile(path.join(folder, `${name}.mjs`), code);
  }
  await writeFile(
    path.join(folder, "api.mjs"),
    "export const shortDate=x=>x; export const units=x=>x; export const won=x=>x.toLocaleString('ko-KR')+'원'; export class ApiError extends Error {} export const api=()=>{throw new Error('Unexpected API request during render')};",
  );
  controls = await import(
    pathToFileURL(path.join(folder, "controls.mjs")).href
  );
  ui = await import(pathToFileURL(path.join(folder, "ui.mjs")).href);
  fields = await import(
    pathToFileURL(path.join(folder, "product-fields.mjs")).href
  );
  language = await import(
    pathToFileURL(path.join(folder, "merchant-language.mjs")).href
  );
  summary = await import(
    pathToFileURL(path.join(folder, "merchant-summary.mjs")).href
  );
  orderDetails = await import(
    pathToFileURL(path.join(folder, "order-details.mjs")).href
  );
  metrics = await import(
    pathToFileURL(path.join(folder, "merchant-metrics.mjs")).href
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

test("merchant totals distinguish zero sales/current zero stock from missing and stale records", () => {
  const products = [
    { id: "A", name: "우유" },
    { id: "B", name: "음료" },
    { id: "C", name: "샌드위치" },
  ];
  const inventory = {
    A: { measured_on: "2026-10-24", batches: [] },
    B: { measured_on: "2026-10-23", batches: [{ quantity: 8 }] },
  };
  const forecast = {
    dates: ["2026-10-25"],
    products: [
      {
        product_id: "A",
        status: "ready",
        points: [{ date: "2026-10-25", p50: 0 }],
      },
      {
        product_id: "B",
        status: "ready",
        points: [{ date: "2026-10-25", p50: 8 }],
      },
      {
        product_id: "C",
        status: "missing",
        points: [{ date: "2026-10-25", p50: 100 }],
      },
      {
        product_id: "not-registered",
        status: "ready",
        points: [{ date: "2026-10-25", p50: 100 }],
      },
    ],
  };
  const orders = [
    { id: "draft", status: "draft", lines: [{ quantity: 7 }] },
    { id: "final", status: "confirmed", lines: [] },
  ];
  const before = JSON.stringify({ products, inventory, forecast, orders });
  const result = summary.merchantSummary(
    products,
    inventory,
    forecast,
    orders,
    "2026-10-24",
  );
  assert.equal(result.demand, 8);
  assert.equal(result.demandCount, 2);
  assert.deepEqual(
    result.ready.map((item) => item.product.id),
    ["A", "B"],
  );
  assert.deepEqual(
    result.missing.map((item) => item.product.id),
    ["B", "C"],
  );
  assert.match(result.missing[0].inventoryReason, /2026-10-23/);
  assert.match(result.missing[1].inventoryReason, /아직 입력하지/);
  assert.deepEqual(
    result.drafts.map((order) => order.id),
    ["draft"],
  );
  assert.equal(
    JSON.stringify({ products, inventory, forecast, orders }),
    before,
  );
  const pending = summary.merchantSummary(
    products,
    inventory,
    null,
    orders,
    "2026-10-24",
  );
  assert.equal(pending.demandCount, 0);
  assert.equal(pending.ready.length, 0);
});

test("product names and supplier searches ignore whitespace and Unicode width", () => {
  const products = [{ id: "P001", name: "바나나 우유", category: "유제품", supplier: "화개 유업" }];
  for (const query of ["바나나우유", "바 나 나 우 유", "화개유업", "Ｐ００１"]) {
    assert.equal(language.filterProducts(products, query, "all").length, 1);
  }
});

test("select chevrons are SVG and backdrop detection excludes dialog padding", () => {
  const html = renderToStaticMarkup(React.createElement(controls.Select, { defaultValue: "A" }, React.createElement("option", { value: "A" }, "상품")));
  assert.ok(html.includes('d="m6 9 6 6 6-6"'));
  assert.ok(!html.includes("⌄"));
  const rect = { left: 20, top: 30, right: 300, bottom: 400 };
  assert.equal(ui.outsideDialog(rect, 10, 200), true);
  assert.equal(ui.outsideDialog(rect, 150, 450), true);
  assert.equal(ui.outsideDialog(rect, 21, 31), false);
});

test("saved order detail shows saved edited quantity and amounts instead of recommendation", () => {
  const order = {
    id: "order",
    order_date: "2026-10-26",
    as_of: "2026-10-24",
    author: "점주",
    status: "draft",
    total: 6650,
    stale: true,
    lines: [
      {
        product_id: "A",
        name: "우유",
        supplier: "화개푸드",
        recommended_quantity: 99,
        quantity: 7,
        amount: 6650,
      },
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(orderDetails.OrderContents, { order }),
  );
  assert.match(html, /2026-10-26/);
  assert.match(html, /우유/);
  assert.match(html, /화개푸드/);
  assert.match(html, /7개/);
  assert.match(html, /6,650원/);
  assert.doesNotMatch(html, /99개/);
  assert.match(html, /저장 후 판매·재고·상품 정보가 바뀌었어요/);
  assert.match(html, /data-label="발주 수량"/);
  const dated = renderToStaticMarkup(
    React.createElement(orderDetails.OrderContents, {
      order: { ...order, stale: false },
      confirmationIssue: "10.24 자료로 만든 발주안이에요. 오늘 자료로 다시 계산해주세요.",
    }),
  );
  assert.match(dated, /10\.24.*오늘 자료/);
  const confirmed = renderToStaticMarkup(
    React.createElement(orderDetails.OrderContents, {
      order: { ...order, status: "confirmed" },
    }),
  );
  assert.doesNotMatch(confirmed, /warning-banner/);
});

test("all four home metrics expose detail buttons and unknown demand stays unreported", () => {
  const html = renderToStaticMarkup(
    React.createElement(metrics.MerchantMetrics, {
      products: [],
      inventory: {},
      forecast: null,
      orders: [],
      today: "2026-10-24",
      onForecast: () => {},
      onInventory: () => {},
      onHistory: () => {},
      onOrders: () => {},
      onOrder: () => {},
    }),
  );
  assert.equal(
    (html.match(/class="metric-card metric-link"/g) ?? []).length,
    4,
  );
  assert.match(html, /예상 판매량 —/);
  assert.match(html, /저장한 상품과 수량 보기/);
  assert.match(html, /확인할 상품 보기/);
  assert.match(html, /type="button"/);
});

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
