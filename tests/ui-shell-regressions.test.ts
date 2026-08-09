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

test("mobile navigation uses a deliberate in-header close control", () => {
  const appNav = readFileSync(path.join(sourceRoot, "components", "AppNav.tsx"), "utf8");
  const sheet = readFileSync(path.join(sourceRoot, "components", "ui", "sheet.tsx"), "utf8");

  assert.match(sheet, /showCloseButton\?: boolean/);
  assert.match(appNav, /showCloseButton=\{false\}/);
  assert.match(appNav, /<SheetClose asChild>[\s\S]*aria-label="Close navigation"/);
  assert.match(appNav, /<PanelLeftClose aria-hidden className="size-5"/);
});

test("login exposes native password-manager semantics", () => {
  const login = readFileSync(path.join(sourceRoot, "routes", "login.tsx"), "utf8");

  assert.match(login, /<form onSubmit=\{handleSubmit\} autoComplete="on"/);
  assert.match(
    login,
    /id="email"[\s\S]*name="username"[\s\S]*autoComplete="username"[\s\S]*id="password"/,
  );
  assert.match(login, /id="password"[\s\S]*name="password"[\s\S]*autoComplete="current-password"/);
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
