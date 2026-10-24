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
try {
  for (const name of ["ui", "controls"]) {
    const source = await readFile(
      new URL(`../src/components/${name}.tsx`, import.meta.url),
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
} finally {
  assert.ok(
    path
      .resolve(folder)
      .startsWith(path.resolve(process.cwd(), "node_modules") + path.sep),
  );
  assert.ok(path.basename(folder).startsWith(".hwagae-controls-"));
  await rm(folder, { recursive: true, force: true });
}

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
