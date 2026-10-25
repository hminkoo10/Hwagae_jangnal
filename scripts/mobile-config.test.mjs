import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("native apps load local assets with platform-specific secure origins", async () => {
  const config = JSON.parse(await read("apps/mobile/capacitor.config.json"));
  assert.equal(config.appId, "kr.milky.hwagae");
  assert.equal(config.webDir, "www");
  assert.deepEqual(config.server, { hostname: "localhost", androidScheme: "https", iosScheme: "capacitor" });
});

test("export bundles the real frontend and production API without demo login", async () => {
  const metadata = JSON.parse(await read("apps/mobile/www/mobile-build.json"));
  assert.equal(metadata.api_base, "https://hwagae.milky.kr/api");
  assert.equal(metadata.demo_login, false);
  const html = await read("apps/mobile/www/index.html");
  assert.match(html, /화개장날/);
  const assets = [...html.matchAll(/(?:src|href)="(\/_next\/[^"?#]+)[^"]*"/g)];
  assert.ok(assets.length > 0, "compiled assets must be bundled");
  for (const [, path] of assets) await read("apps/mobile/www" + path);
  assert.doesNotMatch(html, /src="https?:/);
  // Operators use the web /admin page only; the app bundle has no operator console.
  await assert.rejects(read("apps/mobile/www/admin/index.html"), { code: "ENOENT" });
});

test("Android and iOS use the same app identifier and contain no signing credentials", async () => {
  assert.match(await read("apps/mobile/android/app/build.gradle"), /applicationId\s+['"]kr\.milky\.hwagae['"]/);
  const xcode = await read("apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
  assert.match(xcode, /PRODUCT_BUNDLE_IDENTIFIER = kr\.milky\.hwagae/);
  assert.doesNotMatch(xcode, /DEVELOPMENT_TEAM = [A-Z0-9]+;/);
  assert.match(xcode, /PrivacyInfo.xcprivacy/);
  assert.match(await read("apps/mobile/ios/App/App/PrivacyInfo.xcprivacy"), /C617\.1/);
});
