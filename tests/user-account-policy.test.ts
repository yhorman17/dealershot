import assert from "node:assert/strict";
import test from "node:test";
import { resolveUserAccountUpdate } from "../src/lib/api/user-account-policy.ts";

test("browser input cannot promote a dealer user to owner", () => {
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "staff",
        requestedRole: "owner" as never,
        requestedDealershipId: "dealership-a",
      }),
    /Select a dealer role/,
  );
});

test("existing owner updates preserve owner and clear dealership assignment", () => {
  assert.deepEqual(
    resolveUserAccountUpdate({
      targetRole: "owner",
      requestedDealershipId: "unexpected-dealership",
    }),
    { role: "owner", dealershipId: null },
  );
});

test("browser input cannot change an existing owner role", () => {
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "owner",
        requestedRole: "staff",
        requestedDealershipId: "dealership-a",
      }),
    /Owner roles cannot be changed/,
  );
});

test("dealer updates require a permitted role and dealership", () => {
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "staff",
        requestedDealershipId: "dealership-a",
      }),
    /Select a dealer role/,
  );
  assert.throws(
    () =>
      resolveUserAccountUpdate({
        targetRole: "staff",
        requestedRole: "dealer_admin",
        requestedDealershipId: null,
      }),
    /active dealership/,
  );
  assert.deepEqual(
    resolveUserAccountUpdate({
      targetRole: "staff",
      requestedRole: "dealer_admin",
      requestedDealershipId: "dealership-a",
    }),
    { role: "dealer_admin", dealershipId: "dealership-a" },
  );
});
