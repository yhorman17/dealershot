import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  activeStorePreferenceKey,
  chooseAuthorizedStoreId,
  isStoreSwitchLocked,
} from "../src/lib/active-store.ts";

const root = process.cwd();
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

test("active store selection prefers only authorized persisted values", () => {
  assert.equal(chooseAuthorizedStoreId(["a", "b"], "b", "a"), "b");
  assert.equal(chooseAuthorizedStoreId(["a", "b"], "forged", "a"), "a");
  assert.equal(chooseAuthorizedStoreId(["b"], "a", "a"), "b");
  assert.equal(chooseAuthorizedStoreId([], "a", "a"), null);
  assert.equal(activeStorePreferenceKey("profile-1"), "dealershot.active-store.profile-1");
});

test("critical vehicle and capture workspaces lock global store switching", () => {
  assert.equal(isStoreSwitchLocked("/vehicles/vehicle-1"), true);
  assert.equal(isStoreSwitchLocked("/vehicles/vehicle-1/edit"), true);
  assert.equal(isStoreSwitchLocked("/bulk-photos/session-1"), true);
  assert.equal(isStoreSwitchLocked("/vehicles/new"), false);
  assert.equal(isStoreSwitchLocked("/inventory"), false);
});

test("authenticated shell provides one global active-store context", () => {
  const layout = source("src/routes/_authenticated.tsx");
  const navigation = source("src/components/AppNav.tsx");
  const context = source("src/hooks/use-accessible-dealerships.tsx");
  assert.match(layout, /<ActiveDealershipProvider>[\s\S]*<AppNav>/);
  assert.match(navigation, /Switch active store/);
  assert.match(navigation, /selectedDealershipId/);
  assert.match(context, /activeStorePreferenceKey/);
  assert.match(context, /dealerships\.some\(\(item\) => item\.id === dealershipId\)/);
});

test("operational pages consume global store context without duplicate store selectors", () => {
  for (const name of [
    "dashboard",
    "inventory",
    "backdrops",
    "overlays",
    "documents",
    "export",
    "bulk-photos",
    "reports",
    "settings",
  ]) {
    const route = source(`src/routes/_authenticated/${name}.tsx`);
    assert.match(route, /useAccessibleDealerships/);
    assert.doesNotMatch(route, /placeholder="Select dealership"/);
    assert.doesNotMatch(route, /placeholder="Dealership"/);
    assert.doesNotMatch(route, /ariaLabel="Store to configure"/);
  }
});

test("table pages avoid sticky row-group headers that overlap live status badges", () => {
  for (const name of ["inventory", "reports"]) {
    const route = source(`src/routes/_authenticated/${name}.tsx`);
    assert.doesNotMatch(route, /<thead[^>]*sticky/);
  }
  const inventory = source("src/routes/_authenticated/inventory.tsx");
  assert.match(inventory, /Inventory access required/);
  assert.match(inventory, /!loadingCapabilities && !canAccessInventory/);
});
