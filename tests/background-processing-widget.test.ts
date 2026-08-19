import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("processing widget is authenticated, capability-gated, and active-store scoped", () => {
  const layout = read("src/routes/_authenticated.tsx");
  const nav = read("src/components/AppNav.tsx");
  const widget = read("src/components/BackgroundProcessingStatus.tsx");
  assert.match(layout, /<AppNav>/);
  assert.match(nav, /<BackgroundProcessingStatus \/>/);
  assert.match(widget, /profile\?\.role !== "staff"/);
  assert.match(widget, /capabilities\?\.media === true/);
  assert.match(widget, /_dealership_id: selectedDealershipId/);
  assert.match(widget, /setJobs\(\[\]\)[\s\S]*selectedDealershipId/);
  assert.match(
    widget,
    /const next = await refresh\(\);\s*if \(cancelled\) return;\s*setJobs\(next\)/,
  );
});

test("processing widget renders honest durable queue states and compact camera mode", () => {
  const widget = read("src/components/BackgroundProcessingStatus.tsx");
  assert.match(widget, /"queued" \| "processing" \| "completed" \| "failed"/);
  assert.match(widget, /finished · \$\{activeCount\} active/);
  assert.match(widget, /Retry queued/);
  assert.match(widget, /Removing background/);
  assert.match(widget, /Failed — review or retry from Photo Manager/);
  assert.match(widget, /MutationObserver/);
  assert.match(widget, /cameraOpen/);
  assert.doesNotMatch(widget, /Math\.random|setInterval\([^,]+,\s*100/);
});

test("queue completion announces an immediate authoritative refresh", () => {
  const bulk = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  const review = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  const events = read("src/lib/background-processing-events.ts");
  assert.match(events, /dealershot:background-processing-changed/);
  assert.match(bulk, /if \(queued\) announceBackgroundProcessingChange\(\)/);
  assert.match(review, /if \(queued\) announceBackgroundProcessingChange\(\)/);
});

test("job projection keeps the private queue hidden and uses narrow grants", () => {
  const migration = read(
    "supabase/migrations/20260819175146_background_removal_activity_projection.sql",
  );
  assert.match(migration, /private\.current_user_has_store_capability\(_dealership_id, 'media'\)/);
  assert.match(migration, /job\.dealership_id = _dealership_id/);
  assert.match(migration, /job\.job_type = 'media\.background\.remove'/);
  assert.match(migration, /SET search_path = ''/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_background_removal_activity/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.doesNotMatch(migration, /GRANT SELECT ON private\.background_jobs/);
});
