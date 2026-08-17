import assert from "node:assert/strict";
import test from "node:test";

import { healthResponse } from "../src/lib/health-response.ts";

test("health endpoint returns only minimal status without deployment metadata", async () => {
  const originalCommit = process.env.DEPLOYED_COMMIT_SHA;
  delete process.env.DEPLOYED_COMMIT_SHA;

  try {
    const response = healthResponse(new Request("https://dealershot.example/health"));

    assert.ok(response);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    if (originalCommit === undefined) delete process.env.DEPLOYED_COMMIT_SHA;
    else process.env.DEPLOYED_COMMIT_SHA = originalCommit;
  }
});

test("health endpoint reports the exact deployed commit when available", async () => {
  const originalCommit = process.env.DEPLOYED_COMMIT_SHA;
  process.env.DEPLOYED_COMMIT_SHA = "cb335f223d44088f770cbba1300d7348ddd80419";

  try {
    const response = healthResponse(new Request("https://dealershot.example/health"));

    assert.ok(response);
    assert.deepEqual(await response.json(), {
      status: "ok",
      commit: "cb335f223d44088f770cbba1300d7348ddd80419",
    });
  } finally {
    if (originalCommit === undefined) delete process.env.DEPLOYED_COMMIT_SHA;
    else process.env.DEPLOYED_COMMIT_SHA = originalCommit;
  }
});
