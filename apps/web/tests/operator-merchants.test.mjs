import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = await readFile(
  new URL("../src/components/operator-merchant-table.tsx", import.meta.url),
  "utf8",
);
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  })
  .outputText.replace(
    /from "(react(?:\/jsx-runtime)?)"/g,
    (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`,
  );
const { selectMerchantRows, MerchantManagementTable } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const store = {
  id: "store-one",
  name: "동명 매장",
  city: "광주",
  product_count: 12,
  last_sales_date: "2026-10-24",
};
const contracts = [
  {
    id: "c2",
    email: "second@example.com",
    merchant_name: "나 점주",
    starts_on: "2026-01-01",
    ends_on: "2026-12-31",
    status: "active",
    enabled: true,
    user_id: null,
    access_status: "invited",
    stores: [],
  },
  {
    id: "c1",
    email: "first@example.com",
    merchant_name: "가 점주",
    starts_on: "2026-01-01",
    ends_on: "2026-11-30",
    status: "active",
    enabled: true,
    user_id: "user1",
    access_status: "active",
    stores: [store],
  },
];
const existing = [
  {
    id: "legacy",
    name: "다 점주",
    email: "legacy@example.com",
    stores: [{ ...store, id: "store-two", last_sales_date: "2026-10-23" }],
  },
];

test("one merchant list searches contracted and unlinked accounts including store locations", () => {
  assert.equal(
    selectMerchantRows(contracts, existing, "", "all", "name").length,
    3,
  );
  assert.deepEqual(
    selectMerchantRows(
      contracts,
      existing,
      " LEGACY@EXAMPLE.COM ",
      "all",
      "name",
    ).map((r) => r.id),
    ["merchant-legacy"],
  );
  assert.equal(
    selectMerchantRows(contracts, existing, "광주", "all", "name").length,
    2,
  );
  assert.deepEqual(
    selectMerchantRows(contracts, existing, "", "unlinked", "name").map(
      (r) => r.id,
    ),
    ["merchant-legacy"],
  );
  assert.equal(
    selectMerchantRows(contracts, existing, "", "expired", "name").length,
    0,
  );
});

test("expiry and latest sales sorting put missing dates last without modifying source data", () => {
  assert.deepEqual(
    selectMerchantRows(contracts, existing, "", "all", "expiry").map(
      (r) => r.id,
    ),
    ["contract-c1", "contract-c2", "merchant-legacy"],
  );
  assert.deepEqual(
    selectMerchantRows(contracts, existing, "", "all", "sales").map(
      (r) => r.id,
    ),
    ["contract-c1", "merchant-legacy", "contract-c2"],
  );
  assert.equal(contracts[0].id, "c2");
  assert.equal(contracts[1].stores[0].last_sales_date, "2026-10-24");
});

test("management renders one semantic table with scoped headers and appropriate row actions", () => {
  const rows = selectMerchantRows(contracts, existing, "", "all", "name");
  const html = renderToStaticMarkup(
    React.createElement(MerchantManagementTable, {
      rows,
      busy: false,
      today: "2026-10-24",
      onManage() {},
      onConnect() {},
      onInvite() {},
    }),
  );
  assert.equal((html.match(/<table\b/g) || []).length, 1);
  assert.equal((html.match(/scope="col"/g) || []).length, 7);
  assert.equal((html.match(/scope="row"/g) || []).length, 3);
  assert.match(html, /first@example.com/);
  assert.match(html, /legacy@example.com/);
  assert.match(html, /나 점주 초대 링크 재발급/);
  assert.match(html, /계약 연결/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<article\b|responsive-table/);
  const empty = renderToStaticMarkup(
    React.createElement(MerchantManagementTable, {
      rows: [],
      busy: false,
      today: "2026-10-24",
      onManage() {},
      onConnect() {},
      onInvite() {},
    }),
  );
  assert.match(empty, /colSpan="7"/i);
  assert.match(empty, /조건에 맞는 점주가 없어요/);
});
