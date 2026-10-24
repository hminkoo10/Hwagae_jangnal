import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const nativeFilesAdapter = `data:text/javascript;base64,${Buffer.from("export const shareNativeFile = async () => globalThis.__mobileShareOutcome").toString("base64")}`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll('"./native-files"', JSON.stringify(nativeFilesAdapter));
const { api, ApiError, hasPendingRequests, download } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

for (const outcome of ["shared", "cancelled"]) {
  test(`native ${outcome} reaches export caller without browser fallback`, async (t) => {
    t.after(() => { delete globalThis.__mobileShareOutcome; });
    globalThis.__mobileShareOutcome = outcome;
    t.mock.method(globalThis, "fetch", async () => new Response("상품,수량\n빵,3"));
    assert.equal(await download("/orders/test/export", "test-token", "발주.csv"), outcome === "shared");
    assert.equal(hasPendingRequests(), false);
  });
}

test("API works without the newer AbortSignal static methods", async (t) => {
  for (const method of ["any", "timeout"]) {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, method);
    Object.defineProperty(AbortSignal, method, { configurable: true, value: undefined });
    t.after(() => Object.defineProperty(AbortSignal, method, descriptor));
  }
  assert.equal(AbortSignal.any, undefined);
  assert.equal(AbortSignal.timeout, undefined);
  let received;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const caller = new AbortController();
  const result = await api("/stores", "test-token", { signal: caller.signal });
  assert.deepEqual(result, { ok: true });
  assert.equal(received.options.headers.get("Authorization"), "Bearer test-token");
  assert.equal(received.options.signal.aborted, false);
  caller.abort();
  assert.equal(received.options.signal.aborted, false, "caller listener must be removed");
  assert.equal(hasPendingRequests(), false);
});

test("timeout stays active while JSON body is downloading", async (t) => {
  const realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn) => realTimer(fn, 10));
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  }));
  const result = api("/stores");
  assert.equal(hasPendingRequests(), true);
  await assert.rejects(result, (error) => error instanceof ApiError && error.status === 0 && error.message.includes("응답"));
  assert.equal(hasPendingRequests(), false);
});

test("caller cancellation during body download remains AbortError", async (t) => {
  const caller = new AbortController();
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      bodyStarted();
    }),
  }));
  const result = api("/stores", "", { signal: caller.signal });
  await started;
  caller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(hasPendingRequests(), false);
});

test("HTTP 401 is distinct from a disconnected network", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ detail: "로그인 만료" }), { status: 401 }));
  await assert.rejects(api("/auth/me"), (error) => error instanceof ApiError && error.status === 401);
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(api("/auth/me"), (error) => error instanceof ApiError && error.status === 0);
  assert.equal(hasPendingRequests(), false);
});

test("already aborted request does not leave a pending operation", async (t) => {
  const caller = new AbortController();
  caller.abort();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(api("/stores", "", { signal: caller.signal }), { name: "AbortError" });
  assert.equal(hasPendingRequests(), false);
});
