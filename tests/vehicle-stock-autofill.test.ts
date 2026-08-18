import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createVehicleFormState,
  deriveStockNumber,
  emptyVehicleValues,
  vehicleFormReducer,
} from "../src/lib/vehicle-form-state.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("the vehicle form derives uppercase stock from the final eight VIN characters", () => {
  let state = createVehicleFormState();
  state = vehicleFormReducer(state, { type: "vin", value: "638gdkne123456" });
  assert.equal(state.values.vin, "638GDKNE123456");
  assert.equal(state.values.stock_number, "NE123456");
  assert.equal(deriveStockNumber("1V2ABCDEF12345678"), "12345678");
});

test("automatic stock follows VIN changes until the user overrides it", () => {
  let state = createVehicleFormState();
  state = vehicleFormReducer(state, { type: "vin", value: "123456789ABCDEFG" });
  assert.equal(state.values.stock_number, "9ABCDEFG");
  state = vehicleFormReducer(state, { type: "vin", value: "123456789HIJKLM" });
  assert.equal(state.values.stock_number, "89HIJKLM");

  state = vehicleFormReducer(state, { type: "stock", value: "RC123456" });
  state = vehicleFormReducer(state, { type: "vin", value: "1V2ABCDEF12345678" });
  assert.equal(state.values.stock_number, "RC123456");
});

test("clearing a manual stock value predictably resumes automatic derivation", () => {
  let state = createVehicleFormState();
  state = vehicleFormReducer(state, { type: "vin", value: "638GDKNE123456" });
  state = vehicleFormReducer(state, { type: "stock", value: "RC123456" });
  state = vehicleFormReducer(state, { type: "stock", value: "" });
  assert.equal(state.stockSource, "automatic");
  assert.equal(state.values.stock_number, "NE123456");
  state = vehicleFormReducer(state, { type: "vin", value: "1V2ABCDEF12345678" });
  assert.equal(state.values.stock_number, "12345678");
});

test("short VINs are safe and use the available uppercase characters", () => {
  let state = createVehicleFormState();
  state = vehicleFormReducer(state, { type: "vin", value: "ab12" });
  assert.equal(state.values.vin, "AB12");
  assert.equal(state.values.stock_number, "AB12");
});

test("existing or imported non-empty stock values remain authoritative", () => {
  const existing = createVehicleFormState({
    ...emptyVehicleValues,
    vin: "1V2ABCDEF12345678",
    stock_number: "Dealer-42",
  });
  assert.equal(existing.values.stock_number, "Dealer-42");
  assert.equal(existing.stockSource, "manual");
  assert.equal(
    vehicleFormReducer(existing, { type: "vin", value: "638GDKNE123456" }).values.stock_number,
    "Dealer-42",
  );
});

test("the actual VehicleForm inputs use the identity reducer without role-specific behavior", () => {
  const form = read("src/components/VehicleForm.tsx");
  assert.match(form, /useReducer\([\s\S]*vehicleFormReducer[\s\S]*createVehicleFormState/);
  assert.match(form, /dispatch\(\{ type: "vin", value: e\.target\.value \}\)/);
  assert.match(form, /dispatch\(\{ type: "stock", value: v \}\)/);
  assert.doesNotMatch(form, /profile\.role|Owner|dealer_admin|staff/);
});

test("stock convenience does not bypass existing inventory authorization", () => {
  const newRoute = read("src/routes/_authenticated/vehicles.new.tsx");
  const form = read("src/components/VehicleForm.tsx");
  assert.match(newRoute, /\/_authenticated\/vehicles\/new/);
  assert.match(form, /supabase[\s\S]*\.from\("vehicles"\)[\s\S]*\.insert\(/);
  assert.doesNotMatch(form, /service_role|supabaseAdmin/);
});
