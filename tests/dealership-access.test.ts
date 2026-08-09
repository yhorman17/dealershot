import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("resource routes use the shared RLS-filtered dealership selector", () => {
  for (const name of ["overlays", "backdrops", "documents", "inventory", "export"]) {
    const route = source(`src/routes/_authenticated/${name}.tsx`);
    assert.match(route, /useAccessibleDealerships/);
    assert.match(route, /canSwitchDealerships/);
  }
});

test("dealer administrators can open their assigned dealership list without owner controls", () => {
  const dealerships = source("src/routes/_authenticated/dealerships.tsx");
  assert.match(dealerships, /profile\?\.role === "dealer_admin"/);
  assert.match(dealerships, /isOwner &&/);
  assert.doesNotMatch(dealerships, /View dealership/);
  assert.doesNotMatch(dealerships, /\/dealerships\/\$dealershipId/);
});

test("overlay and backdrop cards expose preview and rename actions", () => {
  for (const name of ["overlays", "backdrops"]) {
    const route = source(`src/routes/_authenticated/${name}.tsx`);
    assert.match(route, /MediaPreviewDialog/);
    assert.match(route, /RenameMediaDialog/);
    assert.match(route, />\s*View\s*</);
    assert.match(route, />\s*Edit\s*</);
  }
});

test("user administration submits an assignment list through the server function", () => {
  const users = source("src/routes/_authenticated/users.tsx");
  const server = source("src/lib/api/users.functions.ts");
  const migration = source(
    "supabase/migrations/20260809201651_admin_provisioned_user_accounts.sql",
  );
  assert.match(users, /dealership_ids: user\.role === "owner" \? \[\] : dealershipIds/);
  assert.match(server, /admin_update_user_account_access/);
  assert.match(server, /assertRequestedScope/);
  assert.match(migration, /validate_dealer_account_scope/);
});
