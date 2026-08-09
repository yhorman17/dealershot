import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routesRoot = path.join(repositoryRoot, "src", "routes", "_authenticated");

function routeSource(name: string) {
  return readFileSync(path.join(routesRoot, name), "utf8");
}

test("dealership details are restricted to owners", () => {
  const details = routeSource("dealerships.$dealershipId.tsx");

  assert.match(details, /profile\.role !== "owner"/);
  assert.match(details, /navigate\(\{ to: "\/dashboard", replace: true \}\)/);
  assert.match(details, /if \(profile\?\.role !== "owner"\) return null/);
});

test("dealership details scope every asset manager link", () => {
  const details = routeSource("dealerships.$dealershipId.tsx");

  for (const route of ["/overlays", "/backdrops", "/documents"]) {
    assert.match(details, new RegExp(`to: "${route}" as const`));
  }
  assert.match(details, /search=\{\{ dealership: dealership\.id \}\}/);
});

test("tenant resource routes validate and honor dealership context", () => {
  for (const name of ["overlays.tsx", "backdrops.tsx", "documents.tsx"]) {
    const source = routeSource(name);
    assert.match(source, /validateSearch:[\s\S]*typeof search\.dealership === "string"/);
    assert.match(source, /const \{ dealership \} = Route\.useSearch\(\)/);
    assert.match(source, /list\.some\(\(item\) => item\.id === dealership\)/);
  }
});

test("dealership list links to the owner workspace", () => {
  const dealerships = routeSource("dealerships.tsx");

  assert.match(dealerships, /to="\/dealerships\/\$dealershipId"/);
  assert.match(dealerships, /params=\{\{ dealershipId: d\.id \}\}/);
});
