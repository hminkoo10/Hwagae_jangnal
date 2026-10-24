import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";

const pairs = [
  ["../apps/web/.env.example", "../apps/web/.env.local"],
  ["../apps/api/.env.example", "../apps/api/.env"],
];

for (const [source, destination] of pairs) {
  const target = new URL(destination, import.meta.url);
  try {
    await copyFile(
      new URL(source, import.meta.url),
      target,
      constants.COPYFILE_EXCL,
    );
    console.log(`Created ${fileURLToPath(target)}`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(`Kept existing ${fileURLToPath(target)}`);
  }
}
