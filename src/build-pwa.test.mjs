import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPwa } from "./build-pwa.mjs";

test("PWA builds produce valid, stable PNG URLs and change them when the SVG changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quota-pwa-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const original = await readFile(new URL("./public/icon.svg", import.meta.url), "utf8");
  const template = await readFile(new URL("./public/manifest.webmanifest", import.meta.url), "utf8");
  await writeFile(join(source, "manifest.webmanifest"), template);

  async function build(name, svg) {
    const output = join(root, name);
    await mkdir(output);
    await writeFile(join(source, "icon.svg"), svg);
    await writeFile(join(output, "sw.js"), 'const CACHE = "quota-dashboard-shell-v3-__PWA_ICON_REVISION__"; const SHELL = ["__PWA_ICON_PATHS__"];');
    await buildPwa(source, output);
    const manifest = JSON.parse(await readFile(join(output, "manifest.webmanifest"), "utf8"));
    const worker = await readFile(join(output, "sw.js"), "utf8");
    assert.equal(manifest.start_url, JSON.parse(template).start_url);
    assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
    for (const icon of manifest.icons) {
      assert.match(icon.src, /^\/icon-(192|512)-[a-f0-9]{16}\.png$/);
      assert.equal(icon.type, "image/png");
      assert.equal(icon.purpose, "any");
      const png = await readFile(join(output, icon.src.slice(1)));
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      const size = Number(icon.sizes.split("x")[0]);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      assert.ok(worker.includes(icon.src));
    }
    assert.doesNotMatch(worker, /__PWA_ICON_/);
    return { manifest, worker };
  }

  const first = await build("first", original);
  const repeated = await build("repeated", original);
  assert.deepEqual(repeated, first);
  const changed = await build("changed", original.replace("#83bfff", "#ff0000"));
  for (let i = 0; i < first.manifest.icons.length; i++) {
    assert.notEqual(changed.manifest.icons[i].src, first.manifest.icons[i].src);
  }
  assert.notEqual(changed.worker, first.worker);
});

test("production build includes generated icons in the manifest and offline shell", async () => {
  const base = new URL("./dist/public/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", base), "utf8"));
  const worker = await readFile(new URL("sw.js", base), "utf8");
  assert.doesNotMatch(worker, /__PWA_ICON_/);
  // Post-compilation substitutions invalidate TypeScript's column mappings.
  assert.doesNotMatch(worker, /sourceMappingURL/);
  await assert.rejects(readFile(new URL("sw.js.map", base)), { code: "ENOENT" });
  assert.equal(manifest.icons.length, 2);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    assert.ok(worker.includes(icon.src));
    await readFile(new URL(icon.src.slice(1), base));
  }
});
