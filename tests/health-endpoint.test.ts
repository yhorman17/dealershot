import assert from "node:assert/strict";
import test from "node:test";

import { healthResponse } from "../src/lib/health-response.ts";

test("health endpoint returns only minimal status", async () => {
  const response = healthResponse(new Request("https://dealershot.example/health"));

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});
