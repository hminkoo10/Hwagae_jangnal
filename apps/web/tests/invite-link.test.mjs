import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/invite-link.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const link = await import(`data:text/javascript,${encodeURIComponent(code)}`);

test("web and app invite links carry the same owner or staff token", () => {
  const owner = link.inviteFromHash("#invite=abc%2Bdef");
  assert.deepEqual(owner, { token: "abc+def", kind: "owner" });
  assert.deepEqual(link.inviteFromHash("#staff-invite=xyz"), { token: "xyz", kind: "staff" });
  assert.equal(link.inviteFromHash("#other=1"), null);
  const app = link.appInviteUrl(owner);
  assert.equal(app, "kr.milky.hwagae://invite?invite=abc%2Bdef");
  assert.deepEqual(link.inviteFromAppUrl(app), owner);
  assert.equal(link.inviteFromAppUrl("kr.milky.hwagae.admin://invite?invite=abc"), null);
  assert.equal(link.inviteFromHash(`#${link.inviteHash({ token: "xyz", kind: "staff" })}`).token, "xyz");
});

test("android hands off with a web fallback that does not redirect again", () => {
  const invite = { token: "tok", kind: "staff" };
  const fallback = link.webInviteUrl("https://hwagae.milky.kr", invite);
  assert.equal(fallback, "https://hwagae.milky.kr/?noapp=1#staff-invite=tok");
  const intent = link.androidInviteIntent(invite, fallback);
  assert.match(intent, /^intent:\/\/invite\?staff-invite=tok#Intent;scheme=kr\.milky\.hwagae;package=kr\.milky\.hwagae;/);
  assert.ok(intent.includes(`S.browser_fallback_url=${encodeURIComponent(fallback)};end`));
});

test("phones and tablets are detected, desktops are not", () => {
  assert.equal(link.mobilePlatform("Mozilla/5.0 (Linux; Android 14)", 5), "android");
  assert.equal(link.mobilePlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5), "ios");
  assert.equal(link.mobilePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), "ios");
  assert.equal(link.mobilePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), null);
  assert.equal(link.mobilePlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0), null);
});
