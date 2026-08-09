import assert from "node:assert/strict";
import test from "node:test";
import { resolveUserAccountUpdate } from "../src/lib/api/user-account-policy.ts";

test("browser input cannot promote a dealer user to owner", () => {
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "staff",
        requestedRole: "owner" as never,
        requestedDealershipIds: ["dealership-a"],
      }),
    /Select a dealer role/,
  );
});

test("existing owner updates preserve owner and clear dealership assignment", () => {
  assert.deepEqual(
    resolveUserAccountUpdate({
      targetRole: "owner",
      requestedDealershipIds: ["unexpected-dealership"],
    }),
    { role: "owner", dealershipId: null, dealershipIds: [] },
  );
});

test("browser input cannot change an existing owner role", () => {
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "owner",
        requestedRole: "staff",
        requestedDealershipIds: ["dealership-a"],
      }),
    /Owner roles cannot be changed/,
  );
});

test("dealer updates require a permitted role and dealership", () => {
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "staff",
        requestedDealershipIds: ["dealership-a"],
      }),
    /Select a dealer role/,
  );
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "staff",
        requestedRole: "dealer_admin",
        requestedDealershipIds: [],
      }),
    /active dealership/,
  );
  assert.deepEqual(
    resolveUserAccountUpdate({
      targetRole: "staff",
      requestedRole: "dealer_admin",
      requestedDealershipIds: ["dealership-a", "dealership-b", "dealership-a"],
    }),
    {
      role: "dealer_admin",
      dealershipId: "dealership-a",
      dealershipIds: ["dealership-a", "dealership-b"],
    },
  );
});

test("staff accounts cannot receive multiple dealership assignments", () => {
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "dealer_admin",
        requestedRole: "staff",
        requestedDealershipIds: ["dealership-a", "dealership-b"],
      }),
    /exactly one dealership/,
  );
});
