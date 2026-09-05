import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  filterHiddenFinishedGroups,
  parseBackgroundActivityGroups,
  summarizeBackgroundActivity,
  type BackgroundActivity,
} from "../src/lib/background-processing-activity.ts";

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
  assert.match(widget, /setGroups\(\[\]\)[\s\S]*selectedDealershipId/);
  assert.match(
    widget,
    /const next = await refresh\(\);\s*if \(cancelled\) return;\s*setGroups\(next\)/,
  );
});

test("processing widget renders honest durable queue states and compact camera mode", () => {
  const widget = read("src/components/BackgroundProcessingStatus.tsx");
  assert.match(widget, /status === "needs_review"/);
  assert.match(widget, /\$\{activeCount\} active/);
  assert.match(widget, /Retry queued/);
  assert.match(widget, /Removing background/);
  assert.match(widget, /Canceled — original retained/);
  assert.match(widget, /MutationObserver/);
  assert.match(widget, /cameraOpen/);
  assert.doesNotMatch(widget, /Math\.random|setInterval\([^,]+,\s*100/);
});

test("processing widget exposes authoritative retry/cancel actions and scoped scrollbar", () => {
  const widget = read("src/components/BackgroundProcessingStatus.tsx");
  const styles = read("src/styles.css");
  assert.match(widget, /retry_background_removal/);
  assert.match(widget, /cancel_background_removal/);
  assert.match(widget, /job\.retryable/);
  assert.match(widget, /job\.cancelable/);
  assert.match(widget, /Cancel processing/);
  assert.match(widget, /announceBackgroundProcessingChange/);
  assert.match(widget, /activeStoreRef\.current === storeAtSubmit/);
  assert.match(widget, /processing-widget-scrollbar/);
  assert.match(styles, /\.processing-widget-scrollbar\s*\{[\s\S]*scrollbar-width: thin/);
  assert.match(styles, /\.processing-widget-scrollbar::-webkit-scrollbar-thumb:hover/);
  assert.doesNotMatch(styles, /^\*::-(webkit-)?scrollbar/m);
});

test("processing widget exposes compact store-scoped bulk retry and cancel controls", () => {
  const widget = read("src/components/BackgroundProcessingStatus.tsx");
  assert.match(widget, /retry_failed_background_removals/);
  assert.match(widget, /cancel_background_removals/);
  assert.match(widget, /Retry All Failed/);
  assert.match(widget, /Cancel All/);
  assert.match(widget, /Cancel all background-removal work\?/);
  assert.match(widget, /Original photos[\s\S]*completed cutouts remain[\s\S]*intact\./);
  assert.match(widget, /activeStoreRef\.current === storeAtSubmit/);
  assert.match(widget, /const authoritative = await refresh\(\)/);
  assert.match(widget, /disabled=\{submitting !== null\}/);
});

test("processing widget consumes grouped vehicle activity with compact progress and nested detail", () => {
  const widget = read("src/components/BackgroundProcessingStatus.tsx");
  const migration = read(
    "supabase/migrations/20260905012459_grounding_v3_grouped_background_activity.sql",
  );
  assert.match(widget, /get_background_removal_activity_grouped/);
  assert.match(widget, /visibleGroups\.map/);
  assert.match(widget, /role="progressbar"/);
  assert.match(widget, /Retry failed/);
  assert.match(widget, /Cancel active/);
  assert.match(widget, /expandedVehicles/);
  assert.match(migration, /GROUP BY vehicle_group_key/);
  assert.match(migration, /jsonb_agg\(to_jsonb\(selected\) - 'vehicle_group_key'/);
  assert.match(migration, /current_user_has_store_capability\(_dealership_id, 'media'\)/);
  assert.match(migration, /SET search_path = ''/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/);
});

const activity = (
  jobId: string,
  status: BackgroundActivity["status"],
  overrides: Partial<BackgroundActivity> = {},
): BackgroundActivity => ({
  job_id: jobId,
  media_asset_id: `media-${jobId}`,
  photo_id: `photo-${jobId}`,
  vehicle_id: "vehicle-1",
  stock_number: "12345678",
  vehicle_label: "2024 Volkswagen Atlas",
  shot_type: null,
  photo_sort_order: 0,
  status,
  retryable: status === "failed",
  cancelable: status === "queued" || status === "processing" || status === "failed",
  cancel_requested: false,
  safe_failure_label: null,
  failure_category: null,
  deterministic_failure_count: 0,
  has_draft: false,
  fix_cutout_available: false,
  attempt_count: 0,
  max_attempts: 3,
  created_at: "2026-09-05T00:00:00.000Z",
  started_at: null,
  completed_at: null,
  updated_at: "2026-09-05T00:00:00.000Z",
  ...overrides,
});

test("grouped activity parser keeps one stable row per vehicle and honest mixed-state counts", () => {
  const items = [
    activity("1", "completed"),
    activity("2", "processing", { photo_sort_order: 1 }),
    activity("3", "failed", { photo_sort_order: 2 }),
    activity("4", "needs_review", { photo_sort_order: 3 }),
  ];
  const groups = parseBackgroundActivityGroups({
    vehicles: [
      {
        group_key: "vehicle-1",
        vehicle_id: "vehicle-1",
        stock_number: "12345678",
        vehicle_label: "2024 Volkswagen Atlas",
        updated_at: "2026-09-05T00:00:00.000Z",
        items,
      },
    ],
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.items.length, 4);
  assert.deepEqual(summarizeBackgroundActivity(items), {
    queued: 0,
    processing: 1,
    completed: 1,
    needsReview: 1,
    failed: 1,
    canceled: 0,
    total: 4,
    terminal: 3,
  });
  assert.equal(groups[0]!.progressPercent, 75);
  assert.equal(groups[0]!.retryableFailedCount, 1);
  assert.equal(groups[0]!.cancelableCount, 2);
});

test("clearing finished children preserves active and failed vehicle activity", () => {
  const groups = parseBackgroundActivityGroups({
    vehicles: [
      {
        group_key: "vehicle-1",
        vehicle_id: "vehicle-1",
        updated_at: "2026-09-05T00:00:00.000Z",
        items: [activity("1", "completed"), activity("2", "failed")],
      },
    ],
  });
  const visible = filterHiddenFinishedGroups(groups, new Set(["1"]));
  assert.equal(visible.length, 1);
  assert.deepEqual(
    visible[0]!.items.map((item) => item.job_id),
    ["2"],
  );
  assert.equal(visible[0]!.progressPercent, 100);
});

test("queue completion announces an immediate authoritative refresh", () => {
  const bulk = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  const review = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  const events = read("src/lib/background-processing-events.ts");
  assert.match(events, /dealershot:background-processing-changed/);
  assert.match(bulk, /if \(queued\) announceBackgroundProcessingChange\(\)/);
  assert.match(review, /if \(result\.queued_count\) announceBackgroundProcessingChange\(\)/);
});

test("job projection keeps the private queue hidden and uses narrow grants", () => {
  const migration = read(
    "supabase/migrations/20260819210739_background_processing_state_controls.sql",
  );
  assert.match(migration, /private\.current_user_has_store_capability\(_dealership_id, 'media'\)/);
  assert.match(migration, /job\.dealership_id = _dealership_id/);
  assert.match(migration, /job\.job_type = 'media\.background\.remove'/);
  assert.match(migration, /SET search_path = ''/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_background_removal_activity/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.doesNotMatch(migration, /GRANT SELECT ON private\.background_jobs/);
});
