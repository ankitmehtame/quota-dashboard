import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

export async function buildPwa(source, output) {
  const svg = await readFile(join(source, "icon.svg"));
  const icons = [192, 512].map((size) => {
    const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
    const hash = createHash("sha256").update(png).digest("hex").slice(0, 16);
    return { png, src: `/icon-${size}-${hash}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any" };
  });
  await Promise.all(icons.map(({ png, src }) => writeFile(join(output, src.slice(1)), png)));
  const manifest = JSON.parse(await readFile(join(source, "manifest.webmanifest"), "utf8"));
  manifest.icons = icons.map(({ png, ...icon }) => icon);
  await writeFile(join(output, "manifest.webmanifest"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Change the worker and its shell cache whenever generated icon URLs change.
  const revision = createHash("sha256").update(JSON.stringify(manifest.icons)).digest("hex").slice(0, 16);
  const workerPath = join(output, "sw.js");
  const worker = await readFile(workerPath, "utf8");
  await writeFile(workerPath, worker
    .replace("__PWA_ICON_REVISION__", revision)
    .replace('"__PWA_ICON_PATHS__"', icons.map(({ src }) => JSON.stringify(src)).join(", ")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(fileURLToPath(import.meta.url));
  await buildPwa(join(root, "public"), join(root, "dist/public"));
}
