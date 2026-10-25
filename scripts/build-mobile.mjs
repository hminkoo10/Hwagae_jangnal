import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(root, "apps", "mobile");
const web = join(root, "apps", "web");
const destination = join(mobile, "www");
const require = createRequire(import.meta.url);
const apiBase = "https://hwagae.milky.kr/api";
await mkdir(mobile, { recursive: true });
const staging = await mkdtemp(join(mobile, ".web-build-"));

// Only remove generated directories within this app, never a source checkout
// or a symlink resolving outside the mobile workspace.
async function removeGenerated(target) {
  const actual = await realpath(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const parent = await realpath(mobile);
  if (!actual) return;
  if (!actual.startsWith(parent + sep) ||
      (target !== destination && target !== staging)) {
    throw new Error("Refusing to remove a path outside generated mobile output.");
  }
  await rm(target, { recursive: true, force: true });
}

try {
  await cp(join(web, "src"), join(staging, "src"), { recursive: true });
  // The app is for owners and staff; the operator console stays on the web at /admin.
  await rm(join(staging, "src", "app", "admin"), { recursive: true, force: true });
  await cp(join(web, "tsconfig.json"), join(staging, "tsconfig.json"));
  await cp(join(web, "package.json"), join(staging, "package.json"));
  await cp(join(web, "public"), join(staging, "public"), { recursive: true }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await writeFile(join(staging, "next.config.mjs"),
    `export default ${JSON.stringify({
      output: "export", trailingSlash: true, images: { unoptimized: true },
      turbopack: { root },
    }, null, 2)};\n`);
  const child = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build", staging], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: apiBase,
      NEXT_PUBLIC_DEMO_LOGIN_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (child.error || child.status !== 0) throw child.error ?? new Error("Mobile web build failed.");
  const output = join(staging, "out");
  await readFile(join(output, "index.html"));
  await removeGenerated(destination);
  await cp(output, destination, { recursive: true });
  await writeFile(join(destination, "mobile-build.json"), JSON.stringify({
    schema_version: 1, app_id: "kr.milky.hwagae", api_base: apiBase,
    demo_login: false, built_at: new Date().toISOString(),
  }, null, 2) + "\n");
  console.log("Mobile bundle ready: apps/mobile/www (production API; no website build overwritten)");
} finally {
  await removeGenerated(staging);
}
