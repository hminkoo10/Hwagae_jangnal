import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const adapters = {
  "@capacitor/core": dataModule("export const Capacitor = { isNativePlatform: () => globalThis.__nativeFileTest.native }"),
  "@capacitor/filesystem": dataModule("export const Directory = { Cache: 'CACHE' }; export const Filesystem = { writeFile: async (options) => globalThis.__nativeFileTest.writeFile(options) }"),
  "@capacitor/share": dataModule("export const Share = { share: async (options) => globalThis.__nativeFileTest.share(options) }"),
};
const source = await readFile(new URL("../src/lib/native-files.ts", import.meta.url), "utf8");
let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const [specifier, url] of Object.entries(adapters)) {
  compiled = compiled.replaceAll(JSON.stringify(specifier), JSON.stringify(url));
}
const { shareNativeFile } = await import(dataModule(compiled));

test("browser download path does not touch native plugins", async (t) => {
  t.after(() => { delete globalThis.__nativeFileTest; });
  globalThis.__nativeFileTest = { native: false };
  assert.equal(await shareNativeFile(new Blob(["hello"]), "example.csv"), "browser");
});

for (const [filename, content] of [
  ["화개장날_발주서.csv", Buffer.from("\uFEFF상품명,수량\r\n샌드위치,43\r\n", "utf8")],
  ["화개장날_발주서.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80])],
]) {
  test(`native ${filename} keeps bytes and shares a cache file URI`, async (t) => {
    t.after(() => { delete globalThis.__nativeFileTest; });
    let written;
    let shared;
    globalThis.__nativeFileTest = {
      native: true,
      writeFile: async (options) => {
        written = options;
        return { uri: `file:///cache/${options.path}` };
      },
      share: async (options) => { shared = options; },
    };
    assert.equal(await shareNativeFile(new Blob([content]), filename), "shared");
    assert.equal(written.directory, "CACHE");
    assert.equal(written.recursive, true);
    assert.match(written.path, /^hwagae-exports\/[\w-]+\//);
    assert.equal(written.path.split("/").at(-1), filename);
    assert.deepEqual(Buffer.from(written.data, "base64"), content);
    assert.deepEqual(shared.files, [`file:///cache/${written.path}`]);
  });
}

test("failed native share reaches the caller instead of reporting success", async (t) => {
  t.after(() => { delete globalThis.__nativeFileTest; });
  globalThis.__nativeFileTest = {
    native: true,
    writeFile: async () => ({ uri: "file:///cache/export.csv" }),
    share: async () => { throw new Error("Cannot share file"); },
  };
  await assert.rejects(shareNativeFile(new Blob(["hello"]), "export.csv"), /Cannot share file/);
});

test("dismissing the native share sheet reports cancellation, not success or browser fallback", async (t) => {
  t.after(() => { delete globalThis.__nativeFileTest; });
  globalThis.__nativeFileTest = {
    native: true,
    writeFile: async () => ({ uri: "file:///cache/export.csv" }),
    share: async () => { throw new Error("Share canceled"); },
  };
  assert.equal(await shareNativeFile(new Blob(["hello"]), "export.csv"), "cancelled");
});
