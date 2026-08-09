import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  generateTemporaryPassword,
  isValidTemporaryPassword,
} from "../src/lib/api/temporary-credentials.server.ts";

test("temporary passwords are cryptographically generated with every required class", () => {
  const generated = new Set<string>();
  for (let index = 0; index < 250; index++) {
    const password = generateTemporaryPassword();
    assert.equal(password.length, 20);
    assert.equal(isValidTemporaryPassword(password), true);
    generated.add(password);
  }
  assert.equal(generated.size, 250);
});

test("temporary password generator rejects undersized output", () => {
  assert.throws(() => generateTemporaryPassword(15), /between 16 and 128/);
});

test("credentials are not persisted or logged by the application workflow", () => {
  const root = process.cwd();
  const server = readFileSync(path.join(root, "src/lib/api/users.functions.ts"), "utf8");
  const migration = readFileSync(
    path.join(root, "supabase/migrations/20260809201651_admin_provisioned_user_accounts.sql"),
    "utf8",
  );
  assert.doesNotMatch(server, /console\.(?:log|info|warn|error)\([^\n]*password/i);
  assert.doesNotMatch(migration, /temporary_password\s+(?:text|varchar|character)/i);
  assert.doesNotMatch(migration, /password_hash|credential_secret/i);
});

test("privileged middleware verifies the token against Supabase Auth", () => {
  const middleware = readFileSync(
    path.join(process.cwd(), "src/integrations/supabase/auth-middleware.ts"),
    "utf8",
  );
  assert.match(middleware, /auth\.getUser\(token\)/);
  assert.doesNotMatch(middleware, /auth\.getClaims\(token\)/);
});

test("invitation redirects do not trust a browser-supplied origin", () => {
  const server = readFileSync(path.join(process.cwd(), "src/lib/api/users.functions.ts"), "utf8");
  const invite = readFileSync(
    path.join(process.cwd(), "src/components/InviteUserModal.tsx"),
    "utf8",
  );
  assert.match(server, /getApplicationOrigin\(\)/);
  assert.doesNotMatch(server, /origin:\s*z\.string/);
  assert.doesNotMatch(invite, /window\.location\.origin/);
});
