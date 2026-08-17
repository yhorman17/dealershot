import assert from "node:assert/strict";
import test from "node:test";
import {
  accountingRowsToCsv,
  summarizeAccounting,
  type AccountingRow,
} from "../src/lib/accounting.ts";
import {
  classifyShot,
  preservesOriginal,
  resolveProcessingAction,
} from "../src/lib/media-domain.ts";
import { evaluateRetailReadiness, type ReadinessRule } from "../src/lib/retail-readiness.ts";

const baseRules: ReadinessRule[] = [
  {
    key: "vehicle.vin",
    label: "VIN available",
    severity: "blocked",
    enabled: true,
    appliesTo: ["new", "used", "certified"],
  },
  {
    key: "vehicle.price",
    label: "Retail price available",
    severity: "attention",
    enabled: true,
    appliesTo: ["used", "certified"],
  },
  {
    key: "media.minimum_photos",
    label: "Minimum photo count",
    severity: "attention",
    enabled: true,
    appliesTo: ["new", "used", "certified"],
    minimum: 2,
  },
  {
    key: "media.required_shot",
    label: "Front photo",
    severity: "attention",
    enabled: true,
    appliesTo: ["new", "used", "certified"],
    shotType: "Front",
  },
  {
    key: "processing.no_failures",
    label: "No failed processing",
    severity: "blocked",
    enabled: true,
    appliesTo: ["new", "used", "certified"],
  },
];

test("complete configured vehicle becomes Retail Ready", () => {
  const result = evaluateRetailReadiness({
    inventoryType: "used",
    vin: "1HGCM82633A004352",
    stockNumber: "A100",
    price: 24_995,
    photos: [
      { kind: "photo", shotType: "Front", processingStatus: "not_required" },
      { kind: "photo", shotType: "Dashboard", processingStatus: "not_required" },
    ],
    generatedDocumentTypes: ["window_sticker", "buyers_guide"],
    requiredDocumentTypes: ["window_sticker", "buyers_guide"],
    rules: baseRules,
  });
  assert.equal(result.status, "retail_ready");
  assert.deepEqual(result.reasons, []);
});

test("missing price blocks only when the configured rule applies", () => {
  const common = {
    vin: "1HGCM82633A004352",
    photos: [
      { kind: "photo" as const, shotType: "Front" },
      { kind: "photo" as const, shotType: "Rear" },
    ],
    generatedDocumentTypes: [],
    requiredDocumentTypes: [],
    rules: baseRules,
  };
  assert.equal(
    evaluateRetailReadiness({ ...common, inventoryType: "used", price: null }).status,
    "needs_attention",
  );
  assert.equal(
    evaluateRetailReadiness({ ...common, inventoryType: "new", price: null }).status,
    "retail_ready",
  );
});

test("photo completeness reports count and exact missing shot", () => {
  const result = evaluateRetailReadiness({
    inventoryType: "used",
    vin: "1HGCM82633A004352",
    price: 1,
    photos: [{ kind: "photo", shotType: "Rear" }],
    rules: baseRules,
  });
  assert.equal(result.photoCount, 1);
  assert.deepEqual(
    result.reasons.map((reason) => reason.key),
    ["media.minimum_photos", "media.required_shot"],
  );
});

test("processing failures outrank review and attention states", () => {
  const result = evaluateRetailReadiness({
    inventoryType: "used",
    vin: "1HGCM82633A004352",
    price: 1,
    photos: [
      { kind: "photo", shotType: "Front", processingStatus: "failed" },
      { kind: "photo", shotType: "Rear", reviewStatus: "awaiting_review" },
    ],
    rules: baseRules,
  });
  assert.equal(result.status, "blocked");
});

test("classification and selective processing keep capture originals untouched", () => {
  assert.equal(classifyShot("Front 3/4"), "exterior");
  assert.equal(classifyShot("Dashboard"), "interior");
  const rules = [
    {
      mediaCategory: "exterior" as const,
      action: "background_merchandising" as const,
      enabled: true,
    },
    { mediaCategory: "interior" as const, action: "keep_original" as const, enabled: true },
  ];
  assert.equal(
    resolveProcessingAction({ category: "exterior", rules, explicitlyRequested: false }),
    "keep_original",
  );
  assert.equal(
    resolveProcessingAction({ category: "exterior", rules, explicitlyRequested: true }),
    "background_merchandising",
  );
  assert.equal(
    resolveProcessingAction({ category: "interior", rules, explicitlyRequested: true }),
    "keep_original",
  );
  assert.equal(
    preservesOriginal({
      originalUrl: "original.jpg",
      variantUrl: "processed.jpg",
      variantType: "customized",
    }),
    true,
  );
});

test("accounting totals and CSV derive from durable rows", () => {
  const row: AccountingRow = {
    employee: 'Alex "AJ" Smith',
    workDate: "2026-08-17",
    dealership: "Store A",
    stockNumber: "A100",
    vin: "1HGCM82633A004352",
    vehicle: "2025 Test Vehicle",
    taskType: "Photo shoot",
    startedAt: "2026-08-17T13:00:00Z",
    completedAt: "2026-08-17T13:10:00Z",
    durationSeconds: 600,
    photoCount: 24,
    videoCount: 1,
    amount: 12.5,
    payoutStatus: "pending",
    reviewStatus: "awaiting_review",
  };
  assert.deepEqual(summarizeAccounting([row, row]), {
    vehiclesCompleted: 2,
    photos: 48,
    videos: 2,
    payout: 25,
    durationSeconds: 1200,
  });
  const csv = accountingRowsToCsv([row]);
  assert.match(csv, /"Alex ""AJ"" Smith"/);
  assert.match(csv, /"Photo Count"/);
  assert.ok(csv.endsWith("\r\n"));
});
