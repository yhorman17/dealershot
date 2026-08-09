import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(entryPath) : [entryPath];
  });
}

test("collapsed navigation provides the Radix tooltip context", () => {
  const appNav = readFileSync(path.join(sourceRoot, "components", "AppNav.tsx"), "utf8");

  assert.match(
    appNav,
    /return\s*\(\s*<TooltipProvider\s+delayDuration=[\s\S]*\{renderNavigation\(collapsed\)\}[\s\S]*<\/TooltipProvider>\s*\);/,
    "TooltipProvider must wrap the rendered collapsed navigation",
  );
});

test("page entrance animation releases its transform for viewport-fixed overlays", () => {
  const styles = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
  const motionPageRule = styles.match(/\.motion-page\s*\{(?<body>[^}]*)\}/)?.groups?.body;

  assert.ok(motionPageRule, "Expected the shared .motion-page rule");
  assert.doesNotMatch(motionPageRule, /\bboth\b/);
});

test("product screens do not fall back to native select controls", () => {
  const nativeSelects = sourceFiles(sourceRoot)
    .filter((file) => file.endsWith(".tsx"))
    .filter((file) => /<select\b/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(repositoryRoot, file));

  assert.deepEqual(nativeSelects, []);
});
