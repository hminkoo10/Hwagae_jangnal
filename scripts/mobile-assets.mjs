// Rebuild the native artwork from our own SVG. No fonts or remote assets.
// Run from any working directory: node scripts/mobile-assets.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const resources = path.join(root, "apps/mobile/resources");
// Same mark for both apps; the operator app's dark navy keeps the two apart on a home screen.
const apps = [
  { project: "apps/mobile", color: "#487DEE" },
  { project: "apps/mobile-admin", color: "#1E2A44" },
];
const source = await readFile(path.join(resources, "mark.svg"), "utf8");
const mark = source.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1];
if (!mark) throw new Error("Missing storefront SVG artwork");
const canvas = "#F5F8FC";
const svg = (width, height, content) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`,
);
const background = (color, round = false) => round
  ? `<circle cx="54" cy="54" r="54" fill="${color}"/>`
  : `<rect width="108" height="108" rx="23" fill="${color}"/>`;
let files = 0;
let bytes = 0;
async function png(file, image, width, height = width, opaque = null) {
  await mkdir(path.dirname(file), { recursive: true });
  let render = sharp(image).resize(width, height);
  if (opaque) render = render.flatten({ background: opaque }).removeAlpha();
  const buffer = await render.png({ compressionLevel: 9, palette: false }).toBuffer();
  await writeFile(file, buffer);
  files += 1;
  bytes += buffer.length;
}
async function textFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

// Translate the deliberately small SVG path subset to Android vector drawables.
// Keeping the SVG as the single source avoids a second hand-edited logo.
const pathAttributes = {
  fill: "android:fillColor",
  d: "android:pathData",
  stroke: "android:strokeColor",
  "stroke-width": "android:strokeWidth",
  "stroke-linecap": "android:strokeLineCap",
  "stroke-linejoin": "android:strokeLineJoin",
};
const vectorPaths = [...mark.matchAll(/<path\s+([^>]+)\/>/g)].map((match) => {
  const attributes = [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => {
    if (!pathAttributes[key]) throw new Error(`Unsupported SVG attribute: ${key}`);
    return `${pathAttributes[key]}="${value === "none" ? "#00000000" : value}"`;
  });
  return `    <path ${attributes.join(" ")}/>`;
}).join("\n");
const vector = (content, size = 108) => `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="108" android:viewportHeight="108">\n${content}\n</vector>\n`;

function splash(color, width, height, fraction = 0.25) {
  const side = Math.min(width, height) * fraction;
  const scale = side / 108;
  const x = (width - side) / 2;
  const y = (height - side) / 2;
  return svg(width, height,
    `<rect width="${width}" height="${height}" fill="${canvas}"/>` +
    `<g transform="translate(${x} ${y}) scale(${scale})">${background(color)}${mark}</g>`,
  );
}

for (const { project, color } of apps) {
  const android = path.join(root, project, "android/app/src/main/res");
  const ios = path.join(root, project, "ios/App/App/Assets.xcassets");

  // 108dp adaptive foreground. The mark fits in the central 66dp safe circle.
  const densities = { mdpi: [48, 108], hdpi: [72, 162], xhdpi: [96, 216], xxhdpi: [144, 324], xxxhdpi: [192, 432] };
  for (const [density, [legacy, adaptive]] of Object.entries(densities)) {
    const directory = path.join(android, `mipmap-${density}`);
    await png(path.join(directory, "ic_launcher.png"), svg(108, 108, background(color) + mark), legacy);
    await png(path.join(directory, "ic_launcher_round.png"), svg(108, 108, background(color, true) + mark), legacy);
    await png(path.join(directory, "ic_launcher_foreground.png"), svg(108, 108, mark), adaptive);
  }

  await textFile(path.join(android, "drawable-v24/ic_launcher_foreground.xml"), vector(vectorPaths));
  await textFile(path.join(android, "drawable/ic_launcher_background.xml"), vector(`    <path android:fillColor="${color}" android:pathData="M0 0H108V108H0Z"/>`));
  await textFile(path.join(android, "values/ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${color}</color>\n</resources>\n`);
  // Android 12's 288dp splash image keeps all artwork in its 192dp safe circle.
  await textFile(path.join(android, "drawable/hwagae_splash_icon.xml"), vector(
    `    <path android:fillColor="${color}" android:pathData="M88 54a34 34 0 1 1-68 0a34 34 0 1 1 68 0Z"/>\n${vectorPaths}`,
    288,
  ));

  await png(path.join(android, "drawable/splash.png"), splash(color, 480, 320), 480, 320);
  const screens = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
  for (const [density, [width, height]] of Object.entries(screens)) {
    await png(path.join(android, `drawable-port-${density}/splash.png`), splash(color, width, height), width, height);
    await png(path.join(android, `drawable-land-${density}/splash.png`), splash(color, height, width), height, width);
  }

  // iOS applies its own corner mask. App Store icon must have no alpha channel.
  await png(path.join(ios, "AppIcon.appiconset/AppIcon-512@2x.png"), svg(108, 108, `<rect width="108" height="108" fill="${color}"/>` + mark), 1024, 1024, color);
  for (const filename of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    await png(path.join(ios, "Splash.imageset", filename), splash(color, 2732, 2732, 0.19), 2732);
  }
}
console.log(`Generated ${files} native PNGs (${Math.ceil(bytes / 1024)} KiB) and Android vectors for ${apps.length} apps from resources/mark.svg.`);
