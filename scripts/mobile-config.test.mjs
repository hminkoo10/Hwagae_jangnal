import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");
// Build both bundles first: npm run mobile:build && npm run mobile:admin:build
const apps = {
  store: { project: "apps/mobile", appId: "kr.milky.hwagae", appName: "화개장날" },
  admin: { project: "apps/mobile-admin", appId: "kr.milky.hwagae.admin", appName: "화개장날 관리자" },
};
// Text only the merchant login (workspace) or the operator console renders.
const MERCHANT_WORKSPACE = "매장으로 이동 중";
const OPERATOR_CONSOLE = "운영자 로그인";

async function exportBundle(project) {
  const www = `${project}/www`;
  const metadata = JSON.parse(await read(`${www}/mobile-build.json`));
  assert.equal(metadata.api_base, "https://hwagae.milky.kr/api");
  assert.equal(metadata.demo_login, false);
  const html = await read(`${www}/index.html`);
  assert.match(html, /화개장날/);
  const assets = [...html.matchAll(/(?:src|href)="(\/_next\/[^"?#]+)[^"]*"/g)];
  assert.ok(assets.length > 0, "compiled assets must be bundled");
  for (const [, path] of assets) await read(www + path);
  assert.doesNotMatch(html, /src="https?:/);
  const chunks = resolve(root, www, "_next/static/chunks");
  const scripts = (await readdir(chunks, { recursive: true })).filter((file) => file.endsWith(".js"));
  const code = (await Promise.all(scripts.map((file) => readFile(resolve(chunks, file), "utf8")))).join("\n");
  return { metadata, html, code };
}

test("native apps load local assets with platform-specific secure origins", async () => {
  for (const { project, appId, appName } of Object.values(apps)) {
    const config = JSON.parse(await read(`${project}/capacitor.config.json`));
    assert.equal(config.appId, appId);
    assert.equal(config.appName, appName);
    assert.equal(config.webDir, "www");
    assert.deepEqual(config.server, { hostname: "localhost", androidScheme: "https", iosScheme: "capacitor" });
  }
  assert.notEqual(apps.store.appId, apps.admin.appId, "both apps must install side by side");
  assert.notEqual(apps.store.appName, apps.admin.appName);
});

test("store export bundles the merchant app and production API without the operator console", async () => {
  const { metadata, code } = await exportBundle(apps.store.project);
  assert.equal(metadata.app, "store");
  assert.equal(metadata.app_id, apps.store.appId);
  assert.ok(code.includes(MERCHANT_WORKSPACE), "store app must ship the merchant workspace");
  assert.ok(!code.includes(OPERATOR_CONSOLE), "store app must not ship the operator console");
  // Operators use the operator app or the web /admin page; the store bundle has no admin route.
  await assert.rejects(read(`${apps.store.project}/www/admin/index.html`), { code: "ENOENT" });
});

test("operator export opens on the operator console and ships no merchant workspace", async () => {
  const { metadata, html, code } = await exportBundle(apps.admin.project);
  assert.equal(metadata.app, "admin");
  assert.equal(metadata.app_id, apps.admin.appId);
  assert.match(html, /<title>[^<]*서비스 운영자<\/title>/, "entry page must be the operator console");
  assert.ok(code.includes(OPERATOR_CONSOLE), "operator app must ship the operator console");
  assert.ok(!code.includes(MERCHANT_WORKSPACE), "operator app must not ship the merchant workspace");
  await assert.rejects(read(`${apps.admin.project}/www/admin/index.html`), { code: "ENOENT" });
});

test("Android and iOS use each app's identifier and contain no signing credentials", async () => {
  for (const { project, appId, appName } of Object.values(apps)) {
    const id = appId.replaceAll(".", "\\.");
    const gradle = await read(`${project}/android/app/build.gradle`);
    assert.match(gradle, new RegExp(`applicationId\\s+['"]${id}['"]`));
    assert.match(gradle, new RegExp(`namespace\\s*=\\s*['"]${id}['"]`));
    const activity = await read(`${project}/android/app/src/main/java/${appId.replaceAll(".", "/")}/MainActivity.java`);
    assert.match(activity, new RegExp(`^package ${id};`, "m"));
    const strings = await read(`${project}/android/app/src/main/res/values/strings.xml`);
    assert.match(strings, new RegExp(`<string name="app_name">${appName}</string>`));
    assert.match(strings, new RegExp(`<string name="package_name">${id}</string>`));
    assert.match(strings, new RegExp(`<string name="custom_url_scheme">${id}</string>`));
    const xcode = await read(`${project}/ios/App/App.xcodeproj/project.pbxproj`);
    assert.equal(xcode.match(new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = ${id};`, "g"))?.length, 2);
    assert.doesNotMatch(xcode, /DEVELOPMENT_TEAM = [A-Z0-9]+;/);
    assert.match(xcode, /PrivacyInfo.xcprivacy/);
    assert.match(await read(`${project}/ios/App/App/Info.plist`),
      new RegExp(`<key>CFBundleDisplayName</key>\\s*<string>${appName}</string>`));
    assert.match(await read(`${project}/ios/App/App/PrivacyInfo.xcprivacy`), /C617\.1/);
  }
});

test("store app opens invite links on Android and iOS", async () => {
  const manifest = await read("apps/mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.intent\.action\.VIEW[\s\S]*android\.intent\.category\.BROWSABLE[\s\S]*android:scheme="@string\/custom_url_scheme" android:host="invite"/);
  assert.match(await read("apps/mobile/ios/App/App/Info.plist"),
    /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>kr\.milky\.hwagae<\/string>/);
});

test("operator native project never identifies itself as the store app", async () => {
  const files = [
    "capacitor.config.json",
    "android/app/build.gradle",
    "android/app/src/main/res/values/strings.xml",
    "android/app/src/main/java/kr/milky/hwagae/admin/MainActivity.java",
    "ios/App/App.xcodeproj/project.pbxproj",
  ];
  for (const file of files) {
    assert.doesNotMatch(await read(`${apps.admin.project}/${file}`), /kr\.milky\.hwagae(?!\.admin)\b/, file);
  }
  await assert.rejects(read(`${apps.admin.project}/android/app/src/main/java/kr/milky/hwagae/MainActivity.java`),
    { code: "ENOENT" });
});
