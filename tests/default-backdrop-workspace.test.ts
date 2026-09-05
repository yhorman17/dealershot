import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

import { composeDefaultProcessedPhoto } from "../worker/default-backdrop-composition.ts";

const read = async (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("default processed backdrop is a store-owned resource with atomic cutout lineage", async () => {
  const [migration, settings, editor, worker] = await Promise.all([
    read("supabase/migrations/20260905003307_default_backdrop_and_grounding_v2.sql"),
    read("src/routes/_authenticated/settings.tsx"),
    read("src/components/BackgroundEditor.tsx"),
    read("worker/media.ts"),
  ]);

  assert.match(migration, /default_backdrop_id uuid[\s\S]*REFERENCES public\.backdrops\(id\)/);
  assert.match(migration, /selected_backdrop\.dealership_id|dealership_id = _dealership_id/);
  assert.match(migration, /current_user_has_store_capability\(_dealership_id, 'settings'\)/);
  assert.match(
    migration,
    /worker_commit_background_cutout_and_default_composition[\s\S]*TO service_role/,
  );
  assert.match(migration, /worker_commit_background_cutout_and_default_composition/);
  assert.match(migration, /source_variant_id[\s\S]*cutout_id/);
  assert.match(migration, /approved_variant_id = _prepared_variant_id/);
  assert.match(settings, /Default processed-photo backdrop/);
  assert.match(settings, /None \/ Transparent/);
  assert.match(settings, /save_default_processed_backdrop/);
  assert.match(editor, /backdrop_resource_id/);
  assert.match(editor, /perPhotoBackdrop \|\| storeDefault/);
  assert.match(worker, /standard_with_default_backdrop/);
  assert.match(worker, /source\.default_backdrop_bucket === "backdrops"/);
});

test("production worker creates a grounded 1600 by 1200 prepared composition", async () => {
  const width = 320;
  const height = 200;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 42; y <= 150; y += 1) {
    const inset = y < 70 ? 45 : 28;
    for (let x = inset; x < width - inset; x += 1) {
      const body = y <= 130;
      const wheels = ((x >= 55 && x <= 91) || (x >= 226 && x <= 262)) && y >= 116;
      if (!body && !wheels) continue;
      const index = (y * width + x) * 4;
      rgba[index] = 38;
      rgba[index + 1] = 72;
      rgba[index + 2] = 112;
      rgba[index + 3] = 255;
    }
  }
  const cutout = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  const backdrop = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: { r: 238, g: 240, b: 242 },
    },
  })
    .jpeg()
    .toBuffer();

  const result = await composeDefaultProcessedPhoto({
    cutout,
    backdrop,
    shotType: "Front 3/4 driver",
  });
  const metadata = await sharp(result.bytes).metadata();

  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 1200);
  assert.equal(result.grounding.version, "ground-plane-v2");
  assert.ok(result.grounding.contact_zones >= 2);
  assert.equal(result.grounding.reflection_enabled, true);
  assert.ok(result.frame.visibleBounds.bottom <= 1200);
});

test("vehicle workspace hero is 4:3 and its tab scrollbar treatment is scoped", async () => {
  const [workspace, styles] = await Promise.all([
    read("src/routes/_authenticated/vehicles.$id.tsx"),
    read("src/styles.css"),
  ]);

  assert.match(workspace, /aspect-\[4\/3\]/);
  assert.match(workspace, /object-contain/);
  assert.match(workspace, /xl:grid-cols-\[minmax\(0,1fr\)_minmax\(18rem,22rem\)\]/);
  assert.match(workspace, /ds-vehicle-workspace-tabs/);
  assert.match(workspace, /lg:overflow-visible/);
  assert.match(styles, /\.ds-vehicle-workspace-tabs::-webkit-scrollbar/);
  assert.match(styles, /scrollbar-width: none/);
  assert.doesNotMatch(styles, /^\s*\*\s*\{[^}]*scrollbar-width/m);
});
