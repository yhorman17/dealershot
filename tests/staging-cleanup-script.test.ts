import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_ORGANIZATIONS,
  ACCEPTANCE_PROFILES,
  EXECUTION_CONFIRMATION,
  OWNER_PROFILE_ID,
  RETAINED_STORE_ID,
  TARGET_PROJECT_REF,
  parseArgs,
} from "../scripts/ops/cleanup-staging-acceptance.mjs";

test("staging cleanup is dry-run by default", () => {
  const options = parseArgs(["--project-ref", TARGET_PROJECT_REF]);
  assert.equal(options.execute, false);
  assert.equal(options.projectRef, TARGET_PROJECT_REF);
});

test("execution requires an explicit confirmation value", () => {
  const options = parseArgs([
    "--project-ref",
    TARGET_PROJECT_REF,
    "--execute",
    "--confirm",
    EXECUTION_CONFIRMATION,
    "--backup-dir",
    "C:\\sensitive-backup",
  ]);
  assert.equal(options.execute, true);
  assert.equal(options.confirmation, EXECUTION_CONFIRMATION);
  assert.equal(options.backupDir, "C:\\sensitive-backup");
});

test("cleanup manifest uses exact audited IDs and excludes Owner/retained store", () => {
  assert.equal(ACCEPTANCE_ORGANIZATIONS.length, 2);
  assert.equal(ACCEPTANCE_PROFILES.length, 6);
  assert.equal(new Set(ACCEPTANCE_ORGANIZATIONS.map(({ id }) => id)).size, 2);
  assert.equal(new Set(ACCEPTANCE_PROFILES.map(({ id }) => id)).size, 6);
  assert.ok(!ACCEPTANCE_ORGANIZATIONS.some(({ id }) => id === RETAINED_STORE_ID));
  assert.ok(!ACCEPTANCE_PROFILES.some(({ id }) => id === OWNER_PROFILE_ID));
});

test("unknown cleanup arguments fail closed", () => {
  assert.throws(() => parseArgs(["--all-stores"]), /Unknown argument/);
});
